// Vocal isolation signal pipeline (Spleeter 2-stems style), independent of how the neural network is run.
//
//   audio -> 44.1 kHz stereo -> STFT -> |STFT| patches -> MaskModel -> vocal mask -> mask x STFT -> inverse STFT
//         -> mono vocals -> back to the original sample rate
//
// The network is the injected MaskModel: it sees one magnitude patch at a time and returns a vocal mask of the same
// shape. The song is processed patch by patch, so only a few patches of spectrum are alive at once, never the whole
// spectrogram; the vocal signal is overlap-added into its output buffer as soon as a frame's mask is final.

import { resample } from '../resample';
import { abortError } from '../../analysis/abort';
import {
  MODEL_CHANNELS,
  MODEL_SAMPLE_RATE,
  patchLength,
  resolveParams,
  type SeparationParams,
} from './constants';
import { FrameAnalyser, FrameSynthesiser, stftFrameCount } from './stft';

export interface MaskModel {
  /**
   * Run the network on one patch. `input` holds the STFT magnitude of both channels, length
   * patchFrames * modelBins * 2 (1 * 512 * 1024 * 2 for Spleeter; NHWC [1, T, F, 2]), laid out [t][f][c]:
   * element (t * modelBins + f) * 2 + c. Resolve with the vocal mask in [0, 1], same length, same layout.
   * The input buffer is reused for the next patch once the promise settles, so copy it if you keep it.
   */
  run(input: Float32Array): Promise<Float32Array>;
}

export type SeparationStage = 'prepare' | 'separate' | 'finish' | 'done';

export interface SeparationProgress {
  stage: SeparationStage;
  /** Patches already run through the model. */
  patch: number;
  /** Total patches that will be run (0 until the audio is prepared). */
  patches: number;
}

export interface SeparateVocalsOptions {
  /** One (mono) or two (stereo) channels of equal length, as decoded. */
  channels: Float32Array[];
  sampleRate: number;
  model: MaskModel;
  /**
   * 0 (default): patches do not overlap, exactly as Spleeter cuts them.
   * 0.5: patches advance by half a patch and their masks are cross-faded over the overlap, which removes the
   * artefacts at patch boundaries for twice the model runs.
   */
  overlap?: 0 | 0.5;
  /** Called with a non-decreasing fraction in [0, 1] (finally exactly 1). */
  onProgress?: (fraction: number, info: SeparationProgress) => void;
  /** Checked between patches (and between resampling steps); the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Override the Spleeter geometry (constants.ts) for a differently-shaped model. */
  params?: Partial<SeparationParams>;
}

export interface SeparateVocalsResult {
  /**
   * Mono isolated vocal, at `sampleRate`, exactly as long as the input. Not limited or normalised: band-limiting a loud,
   * clipped mix can overshoot +-1 slightly, so the caller clamps when it converts to 16-bit PCM (audio/pcm floatToInt16).
   */
  vocals: Float32Array;
  sampleRate: number;
  /** Model runs made. */
  patches: number;
  /** STFT frames of the song at 44.1 kHz. */
  frames: number;
  overlap: 0 | 0.5;
  /** Wall-clock milliseconds, model time included. */
  elapsedMs: number;
}

/** Let timers, rendering and input run (the model call alone would only yield microtasks with a synchronous model). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function clamp01(m: number): number {
  return m > 0 ? (m < 1 ? m : 1) : 0; // NaN becomes 0
}

/**
 * `x` with every NaN / +-Infinity sample replaced by 0, or `x` itself (no copy) when it has none. One bad sample would
 * otherwise reach the network input and, through 0 * NaN, a whole window of output samples whatever the mask says.
 */
function finiteOrZero(x: Float32Array): Float32Array {
  let i = 0;
  while (i < x.length && Number.isFinite(x[i])) i++;
  if (i === x.length) return x;
  const y = Float32Array.from(x);
  for (; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = 0;
  return y;
}

export async function separateVocals(opts: SeparateVocalsOptions): Promise<SeparateVocalsResult> {
  const { channels, sampleRate, model, signal, onProgress } = opts;
  const overlap = opts.overlap ?? 0;
  if (overlap !== 0 && overlap !== 0.5) throw new Error(`separateVocals: overlap must be 0 or 0.5, got ${String(overlap)}`);
  if (channels.length !== 1 && channels.length !== 2) {
    throw new Error(`separateVocals: expected 1 or 2 channels, got ${channels.length}`);
  }
  const length = channels[0].length;
  if (channels.some((c) => c.length !== length)) throw new Error('separateVocals: channels must have the same length');
  if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error(`separateVocals: invalid sample rate ${sampleRate}`);
  const params = resolveParams(opts.params);
  const { frameLength, modelBins: F, patchFrames: T } = params;
  const started = performance.now();

  let lastFraction = 0;
  let info: SeparationProgress = { stage: 'prepare', patch: 0, patches: 0 };
  const report = (fraction: number, next?: Partial<SeparationProgress>) => {
    info = { ...info, ...next };
    lastFraction = Math.max(lastFraction, Math.min(1, fraction));
    onProgress?.(lastFraction, info);
  };
  const checkAbort = () => {
    if (signal?.aborted) throw abortError('Vocal isolation was cancelled.');
  };

  checkAbort();
  report(0);
  if (length === 0) {
    report(1, { stage: 'done' });
    return { vocals: new Float32Array(0), sampleRate, patches: 0, frames: 0, overlap, elapsedMs: performance.now() - started };
  }

  // 1. Bring the audio to the network's rate. The resampler is one synchronous call per channel, so yield around it.
  // Non-finite samples go first: the resampler would smear one of them over many neighbours.
  const clean = channels.map(finiteOrZero);
  const needsResample = sampleRate !== MODEL_SAMPLE_RATE;
  const preShare = needsResample ? 0.04 : 0;
  const postShare = needsResample ? 0.06 : 0.01;
  let work: Float32Array[] = clean;
  if (needsResample) {
    work = [];
    for (let c = 0; c < clean.length; c++) {
      await yieldToEventLoop();
      checkAbort();
      work.push(resample(clean[c], sampleRate, MODEL_SAMPLE_RATE));
      report((preShare * (c + 1)) / clean.length);
    }
  }
  const n44 = work[0].length;
  const nch = work.length;

  // 2. Patch plan. A patch advances by `hop` frames; the last `keep` frames of one patch are the first of the next.
  const frames = stftFrameCount(n44, params);
  const hop = overlap === 0.5 ? T / 2 : T;
  const keep = T - hop;
  const patches = frames <= T ? 1 : Math.ceil((frames - T) / hop) + 1;
  // Cross-fade weights for overlapped masks: fade[t] + fade[t + T/2] = 1, never zero. The outer half of the first and
  // last patch has no partner to fade with, so it keeps full weight.
  const fade = new Float32Array(T);
  for (let t = 0; t < T; t++) fade[t] = overlap === 0.5 ? Math.sin((Math.PI * (t + 0.5)) / T) ** 2 : 1;
  report(preShare, { stage: 'separate', patch: 0, patches });

  // Rolling window of T frames: complex spectrum per channel, and the mask / weight accumulators.
  const slots = T * F;
  const specRe = work.map(() => new Float32Array(slots));
  const specIm = work.map(() => new Float32Array(slots));
  const maskAcc = new Float32Array(slots * MODEL_CHANNELS);
  const weightAcc = new Float32Array(T);
  const input = new Float32Array(patchLength(params));
  const expected = input.length;

  const analyser = new FrameAnalyser(params);
  const synth = new FrameSynthesiser(n44, params);
  const half = frameLength / 2 + 1;
  const vRe = new Float64Array(half); // bins >= F stay zero for ever
  const vIm = new Float64Array(half);

  for (let k = 0; k < patches; k++) {
    checkAbort();
    const base = k * hop;
    const last = k === patches - 1;

    // Slide the window forward by `hop` frames and clear the part that is new.
    if (k > 0 && keep > 0) {
      for (let c = 0; c < nch; c++) {
        specRe[c].copyWithin(0, hop * F, slots);
        specIm[c].copyWithin(0, hop * F, slots);
      }
      maskAcc.copyWithin(0, hop * F * MODEL_CHANNELS, slots * MODEL_CHANNELS);
      weightAcc.copyWithin(0, hop, T);
    }
    maskAcc.fill(0, keep * F * MODEL_CHANNELS);
    weightAcc.fill(0, keep);
    const firstNew = k > 0 ? keep : 0;
    for (let c = 0; c < nch; c++) {
      analyser.frames(work[c], base + firstNew, T - firstNew, F, specRe[c], specIm[c], firstNew);
    }

    // Network input: magnitudes, [t][f][c]; a mono song feeds the same magnitudes to both model channels.
    const re0 = specRe[0];
    const im0 = specIm[0];
    const re1 = specRe[nch - 1];
    const im1 = specIm[nch - 1];
    for (let i = 0; i < slots; i++) {
      const m0 = Math.sqrt(re0[i] * re0[i] + im0[i] * im0[i]);
      input[2 * i] = m0;
      input[2 * i + 1] = nch === 1 ? m0 : Math.sqrt(re1[i] * re1[i] + im1[i] * im1[i]);
    }

    const mask = await model.run(input);
    if (!mask || mask.length !== expected) {
      throw new Error(`separateVocals: the model returned ${mask ? mask.length : 'nothing'}, expected ${expected} mask values`);
    }
    checkAbort();

    // Accumulate this patch's mask, cross-faded with its neighbours.
    for (let t = 0; t < T; t++) {
      const w = (k === 0 && t < hop) || (last && t >= keep) ? 1 : fade[t];
      weightAcc[t] += w;
      const o = t * F * MODEL_CHANNELS;
      for (let i = 0; i < F * MODEL_CHANNELS; i++) maskAcc[o + i] += w * clamp01(mask[o + i]);
    }

    // Frames whose mask is now final: mask them, go back to the time domain.
    const finalFrames = last ? Math.min(T, frames - base) : hop;
    for (let t = 0; t < finalFrames; t++) {
      const inv = 1 / weightAcc[t];
      const o = t * F;
      for (let f = 0; f < F; f++) {
        const m0 = maskAcc[2 * (o + f)] * inv;
        const m1 = maskAcc[2 * (o + f) + 1] * inv;
        // Mono mix of the two masked channels: 0.5 * (m0 * X0 + m1 * X1), with X1 = X0 for a mono song.
        if (nch === 2) {
          vRe[f] = 0.5 * (m0 * re0[o + f] + m1 * re1[o + f]);
          vIm[f] = 0.5 * (m0 * im0[o + f] + m1 * im1[o + f]);
        } else {
          const m = 0.5 * (m0 + m1);
          vRe[f] = m * re0[o + f];
          vIm[f] = m * im0[o + f];
        }
      }
      synth.add(base + t, vRe, vIm);
    }

    report(preShare + (1 - preShare - postShare) * ((k + 1) / patches), { patch: k + 1 });
    await yieldToEventLoop();
  }

  // 3. Normalise, and return to the caller's sample rate with exactly the caller's length.
  checkAbort();
  report(1 - postShare, { stage: 'finish' });
  let vocals = synth.finish();
  if (needsResample) {
    await yieldToEventLoop();
    checkAbort();
    vocals = resample(vocals, MODEL_SAMPLE_RATE, sampleRate);
  }
  if (vocals.length !== length) {
    const fixed = new Float32Array(length);
    fixed.set(vocals.subarray(0, Math.min(length, vocals.length)));
    vocals = fixed;
  }
  report(1, { stage: 'done' });
  return { vocals, sampleRate, patches, frames, overlap, elapsedMs: performance.now() - started };
}
