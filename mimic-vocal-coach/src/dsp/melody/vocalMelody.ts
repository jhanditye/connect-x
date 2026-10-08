// Lead-vocal melody extraction from a song mix (stereo or mono), fully on device.
//
// Why: trackPitch (YIN) follows the loudest periodic sound, which in a song is usually the bass or
// a guitar, not the singer. Pipeline, all on the 10 ms frame grid of PitchTrack at 22.05 kHz:
//
//   1. STFT (2048-point Hann, 93 ms) of L and R; mid M = (L+R)/2 and side S = (L-R)/2.
//   2. Centre emphasis: |M| x max(0.25, centreness^0.5)   (centre.ts; skipped for mono input).
//   3. Stationary-background suppression: |M| x (1 - 0.8 min(1, median_0.5s(|M|) / |M|)). Chords,
//      pads, organ, drones and held bass notes sit still in every bin; a singing voice (vibrato,
//      glides, vowel changes) does not. This is the stage that matters most: over the proxy grid it
//      lifts raw pitch accuracy from 0.75 to 0.81 (0.61 to 0.75 when the band is 6 dB louder than
//      the voice) and cuts voicing false alarms from 0.52 to 0.16; the stereo cue adds less (0.00-0.04).
//   4. Harmonic-summation salience over the peaks of the cleaned spectrum (salience.ts).
//   5. Viterbi path over salience bins with a pitch-continuity penalty (viterbi.ts).
//   6. Refinement of f0 to a few cents with a harmonic-comb fit on the cleaned spectrum.
//   7. Voicing: level of the cleaned harmonic energy at f0 relative to the clip's own 90th
//      percentile; frames more than 10 dB below it (instrumental passages, breaths) are unvoiced. The level is read from a
//      slightly more strongly suppressed copy of the spectrum than the one the pitch is tracked on (LEVEL_STRENGTH 0.9, tracking
//      0.8): suppressing harder cuts the band's level in the gaps between phrases (voicing false alarms with the voice at the
//      band's level: 0.47 -> 0.13 on the proxy mixes, 0.25 -> 0.04 on real voices over the proxy band) but, used for the pitch
//      too, it also thins a voice that holds a straight note, so the pitch keeps the gentler setting.
//   7b. Fragments: pitch stretches under 150 ms that the confidence cues do not vouch for are dropped (clean.ts).
//   8. Optionally the cleaned mono signal (inverse STFT of the gain applied above, plus a harmonic
//      comb around f0) for listening back; it is NOT suitable for the spectral style measures.
//   9. Noise gate: if less than MIN_HARMONIC_SHARE of the cleaned spectral energy of the voiced frames sits on
//      the harmonics of the tracked pitch (median over those frames), the clip has no melody in it (hiss, wind,
//      applause, a dead microphone) and every frame is reported unvoiced. Real singing, solo or in a mix,
//      measured 0.25-0.51 on thirteen clips (four of them real mixes); white, pink, brown and low-passed
//      noise measured 0.07-0.11. This changes nothing for clips that contain music.
//
// Memory: the cleaned magnitude (372 bins) and salience (222 bins) of every frame are kept as
// Float32, 2.4 KB per 10 ms frame (57 MB for a 4 minute song), plus what the suppression removed as bfloat16 (0.7 KB per
// frame, 18 MB: the voicing level is read from it); everything else is block-local. Measured peak typed-array memory for
// 4 minutes of mono 22.05 kHz input: 83 MB (was 65 MB before the voicing level; about 120 MB with withSignal).
// Time: about 11 ms per second of audio on one Xeon VM core under Node 22 (2.4-2.7 s for 4 minutes of mono,
// 3.2 s stereo, +1.3 s with withSignal, plus about 1.6 s per channel to resample 44.1/48 kHz input to
// 22.05 kHz); not measured on an iPhone.
//
// Input handling: an unusable sample rate (under 4 kHz, NaN), an empty input or under 0.1 s of audio returns an
// empty melody (never throws); non-finite samples count as silence; two identical channels are processed as mono;
// at most MAX_MELODY_SEC (or opts.maxSeconds) from the start is analysed; the inputs are never modified.

import { frameCentre, frameCount, FrameFft, HOP_SEC, OverlapAdd } from './stft';
import { resample, ANALYSIS_RATE } from '../resample';
import type { PitchTrack } from '../pitch';
import { centreGain } from './centre';
import { dropFragments } from './clean';
import { slidingMedian } from './runningMedian';
import { BINS_PER_OCTAVE, SalienceMap } from './salience';
import { trackSalience } from './viterbi';

export const MELODY_FFT_SIZE = 2048;
/** Longest stretch that is analysed (the held spectra are 2.4 KB per frame: 10 minutes is 143 MB); the rest is ignored. */
export const MAX_MELODY_SEC = 600;
/** Lowest sample rate accepted: the cleaned spectrum goes up to 4 kHz. */
const MIN_SAMPLE_RATE = 4000;
/** Median share of spectral energy on the harmonics of the tracked pitch below which the clip counts as noise (see header, 9). */
export const MIN_HARMONIC_SHARE = 0.14;
/** Highest frequency kept in the cleaned spectrum, Hz. */
const MAX_HZ = 4000;
/** Frames per processing block, and half the stationary-median window (0.25 s each side). */
const BLOCK = 600;
const STAT_HALF = 25;
const STAT_STRENGTH = 0.8;
/** Suppression strength of the copy the voicing level is read from (see header, 7). */
const LEVEL_STRENGTH = 0.9;
/** Bins below ~54 Hz are never used (the salience grid starts at 70 Hz). */
const K_START = 5;

/** Refinement search: +/-REFINE_RANGE_CENTS around the Viterbi f0 in REFINE_STEP_CENTS steps. */
const REFINE_RANGE_CENTS = 60;
const REFINE_STEP_CENTS = 4;
const REFINE_MAX_HARMONICS = 12;
const REFINE_MAX_HZ = 3600;

/** Voicing: see applyLevelVoicing. */
const VOICING_ENTER_DB = 10;
const VOICING_HYST_DB = 3;
const VOICING_MAX_GAP_SEC = 0.12;
/** A longer level dip is still bridged when the tracked pitch stays on the same note across it (a held note, not a pause). */
const VOICING_SAME_NOTE_GAP_SEC = 0.4;
const VOICING_SAME_NOTE_SEMITONES = 0.8;
const VOICING_EDGE_FRAMES = 5;
const VOICING_MIN_RUN_SEC = 0.2;
/** Nothing quieter than this (dB re full scale, RMS of the extracted harmonics) counts as singing. */
const VOICING_ABS_FLOOR_DB = -75;

/**
 * Per-frame confidence = P(the tracked pitch is right), a logistic model of two cues fitted on the
 * proxy mixes (leave-one-singer-out AUC 0.84): the salience dominance of the chosen pitch and the
 * level of its harmonics relative to the clip's 90th percentile (dB). The clip-level mean tracked the
 * measured raw pitch accuracy of a clip with r = 0.66 (mean absolute error 6.5 points). Calibrated on
 * synthetic accompaniments: read it as a ranking, not as a guarantee.
 */
const CONF_DOMINANCE = 9.977;
const CONF_REL_LEVEL = 0.1202;
const CONF_INTERCEPT = -3.117;
/** Dominance ignores peaks within 1.5 semitones of the chosen pitch and those an octave / fifth away from it. */
const DOM_EXCLUDE_BINS = Math.round(1.5 * (BINS_PER_OCTAVE / 12));
const DOM_RELATED_TOL_BINS = 3;

/** A Hann-windowed sinusoid of amplitude A peaks at A * sum(win) / 2 = A * 512 in the FFT. */
const PEAK_PER_AMPLITUDE = MELODY_FFT_SIZE / 4;

export interface VocalMelodyOptions {
  /** Lowest / highest f0 of the lead voice, Hz. Defaults 85 and 1100 (all three target singers fit). */
  minHz?: number;
  maxHz?: number;
  /** Also return the cleaned mono signal (one more pass over the audio, about +35 % time, 4 bytes per sample). */
  withSignal?: boolean;
  /** Analyse at most this many seconds from the start (default and ceiling MAX_MELODY_SEC); the track is then shorter than the input. */
  maxSeconds?: number;
  /** Drop short pitch fragments the confidence cues do not vouch for (default true; false only for measuring, see clean.ts). */
  dropFragments?: boolean;
  onProgress?: (fraction: number) => void;
}

export interface VocalMelody {
  /**
   * Same layout as trackPitch: 10 ms frames at 22.05 kHz, f0 in Hz (NaN when unvoiced). `periodicity`
   * holds the per-frame confidence (probability the pitch is right, 0..1); `rmsDb` is the level of the extracted
   * harmonics in dB re full scale (relative loudness contour of the lead vocal; absolute value is
   * biased low by the suppression stages).
   */
  track: PitchTrack;
  /** Clip-level 0..1: expected raw pitch accuracy of the voiced frames (mean frame confidence). Below ~0.7: warn the user. */
  confidence: number;
  /** Cleaned mono vocal estimate at ANALYSIS_RATE, only with opts.withSignal. */
  vocalSignal?: Float32Array;
  /** Side/mid energy ratio in dB (-Infinity for mono or dual-mono input): how much stereo information there was. */
  sideToMidDb: number;
  /** Seconds of the clip that were judged to contain the lead vocal. */
  voicedSec: number;
  /**
   * Median over the frames that passed the level voicing of the share of cleaned spectral energy that sits on the harmonics
   * of the tracked pitch (0 when none passed). Singing measured 0.25-0.51, noise 0.07-0.11; below MIN_HARMONIC_SHARE the clip
   * is reported as having no melody (nothing voiced), and this value says by how much.
   */
  harmonicShare: number;
  /**
   * Per-frame cues behind `track.periodicity` (the same 10 ms grid), for judging a stretch of the track: salience dominance of the
   * chosen pitch, share of the cleaned spectral energy on its harmonics, and the clip's 90th-percentile harmonic level (dB re
   * full scale) that `track.rmsDb` is measured against.
   */
  cues: { dominance: Float32Array; share: Float32Array; levelRefDb: number };
  /** Wall time per stage, ms (diagnostics). */
  timingsMs: Record<string, number>;
}

/** x itself when every sample is finite, otherwise a copy with the bad samples zeroed. */
function finiteCopy(x: Float32Array): Float32Array {
  let bad = -1;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) {
      bad = i;
      break;
    }
  }
  if (bad < 0) return x;
  const y = Float32Array.from(x);
  for (let i = bad; i < y.length; i++) if (!Number.isFinite(y[i])) y[i] = 0;
  return y;
}

export function emptyVocalMelody(): VocalMelody {
  return {
    track: {
      sampleRate: ANALYSIS_RATE,
      hopSec: HOP_SEC,
      times: new Float64Array(0),
      f0: new Float64Array(0),
      periodicity: new Float64Array(0),
      rmsDb: new Float64Array(0),
      voiced: new Uint8Array(0),
    },
    confidence: 0,
    sideToMidDb: -Infinity,
    voicedSec: 0,
    harmonicShare: 0,
    cues: { dominance: new Float32Array(0), share: new Float32Array(0), levelRefDb: 0 },
    timingsMs: {},
  };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** True when both channels hold the same samples (a "stereo" file that is really mono): one channel is then enough. */
function sameSamples(a: Float32Array, b: Float32Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
}

export function extractVocalMelody(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  opts: VocalMelodyOptions = {},
): VocalMelody {
  const progress = (f: number) => opts.onProgress?.(Math.min(1, Math.max(0, f)));
  const timingsMs: Record<string, number> = {};
  let clock = now();
  const lap = (name: string) => {
    const t = now();
    timingsMs[name] = (timingsMs[name] ?? 0) + t - clock;
    clock = t;
  };
  const sr = ANALYSIS_RATE;
  const finish = (result: VocalMelody): VocalMelody => {
    progress(1);
    return result;
  };
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || !left || left.length === 0) return finish(emptyVocalMelody());
  // Non-finite samples would spread through the resampler and the FFTs: treat them as silence.
  const maxSec = Number.isFinite(opts.maxSeconds) ? Math.min(MAX_MELODY_SEC, Math.max(0, opts.maxSeconds as number)) : MAX_MELODY_SEC;
  const maxIn = Math.floor(maxSec * sampleRate);
  const useRight = right && right.length > 0 && !sameSamples(left, right);
  let L = resample(finiteCopy(left.length > maxIn ? left.subarray(0, maxIn) : left), sampleRate, sr);
  let R = useRight && right ? resample(finiteCopy(right.length > maxIn ? right.subarray(0, maxIn) : right), sampleRate, sr) : null;
  if (R && R.length !== L.length) {
    const n = Math.min(L.length, R.length);
    L = L.subarray(0, n);
    R = R.subarray(0, n);
  }
  lap('resample');
  const nFrames = frameCount(L.length, sr);
  if (nFrames < 10) return finish(emptyVocalMelody());
  const fMin = Math.min(400, Math.max(60, Number.isFinite(opts.minHz) ? (opts.minHz as number) : 85));
  const fMax = Math.min(1400, Math.max(fMin * 2, Number.isFinite(opts.maxHz) ? (opts.maxHz as number) : 1100));

  const n = MELODY_FFT_SIZE;
  const binHz = sr / n;
  const K = Math.floor(MAX_HZ / binHz) + 1;
  const sal = new SalienceMap({ sampleRate: sr, fftSize: n, fMin, fMax }, K);
  const nBins = sal.nBins;
  const V = new Float32Array(nFrames * K);
  // min(|M|, stationary median) per bin as bfloat16: what the suppression removed is STAT_STRENGTH x this (see levelPower)
  const M = new Uint16Array(nFrames * K);
  const S = new Float32Array(nFrames * nBins);

  // ---- passes over blocks: spectra, centre emphasis, stationary suppression, salience
  const fft = new FrameFft(n);
  const lre = new Float64Array(n / 2 + 1);
  const lim = new Float64Array(n / 2 + 1);
  const rre = new Float64Array(n / 2 + 1);
  const rim = new Float64Array(n / 2 + 1);
  const pm = new Float64Array(K);
  const ps = new Float64Array(K);
  const smM = new Float64Array(K);
  const smS = new Float64Array(K);
  const gain = new Float32Array(K);
  const maxRows = BLOCK + 2 * STAT_HALF;
  const raw = new Float32Array(maxRows * K);
  const med = new Float32Array(maxRows * K);
  const medScratch = new Float32Array(2 * STAT_HALF + 2);
  let midEnergy = 0;
  let sideEnergy = 0;
  for (let a = 0; a < nFrames; a += BLOCK) {
    const b = Math.min(nFrames, a + BLOCK);
    const lo = Math.max(0, a - STAT_HALF);
    const hi = Math.min(nFrames, b + STAT_HALF);
    const rows = hi - lo;
    for (let t = lo; t < hi; t++) {
      const c = frameCentre(t, sr);
      const base = (t - lo) * K;
      fft.run(L, c, lre, lim);
      if (R === null) {
        for (let k = 0; k < K; k++) raw[base + k] = Math.sqrt(lre[k] * lre[k] + lim[k] * lim[k]);
        continue;
      }
      fft.run(R, c, rre, rim);
      for (let k = 0; k < K; k++) {
        const mr = 0.5 * (lre[k] + rre[k]);
        const mi = 0.5 * (lim[k] + rim[k]);
        const sr_ = 0.5 * (lre[k] - rre[k]);
        const si = 0.5 * (lim[k] - rim[k]);
        pm[k] = mr * mr + mi * mi;
        ps[k] = sr_ * sr_ + si * si;
      }
      centreGain(pm, ps, K, smM, smS, gain);
      for (let k = 0; k < K; k++) raw[base + k] = Math.sqrt(pm[k]) * gain[k];
      if (t >= a && t < b) {
        for (let k = K_START; k < K; k++) {
          midEnergy += pm[k];
          sideEnergy += ps[k];
        }
      }
    }
    lap('spectra');
    for (let k = K_START; k < K; k++) slidingMedian(raw, k, K, rows, 2 * STAT_HALF + 1, med, k, K, medScratch);
    lap('median');
    for (let t = a; t < b; t++) {
      const rb = (t - lo) * K;
      const vb = t * K;
      for (let k = 0; k < K; k++) {
        if (k < K_START) {
          V[vb + k] = 0;
          continue;
        }
        const r = raw[rb + k];
        const ratio = med[rb + k] / (r + 1e-20);
        const still = r * (ratio < 1 ? ratio : 1);
        V[vb + k] = r - STAT_STRENGTH * still;
        M[vb + k] = toBf16(still);
      }
      sal.frame(V, vb, K, S, t * nBins);
    }
    lap('salience');
    progress((0.8 * b) / nFrames);
  }

  // ---- tracking, refinement, level
  const tr = trackSalience(S, nFrames, nBins);
  lap('viterbi');
  progress(0.85);
  const f0 = new Float64Array(nFrames);
  const levelDb = new Float64Array(nFrames);
  const dominance = new Float64Array(nFrames);
  const share = new Float64Array(nFrames);
  const shareTop = Math.min(K, Math.floor(REFINE_MAX_HZ / binHz));
  for (let t = 0; t < nFrames; t++) {
    const r = refineF0(V, t * K, K, binHz, sal.freqOf(tr.bin[t]));
    f0[t] = r.f0;
    // sum over h of (|X_h| / 512)^2 / 2 = mean square of the extracted harmonics (of the more strongly suppressed copy)
    levelDb[t] = 10 * Math.log10(levelPower(V, M, t * K, K, binHz, r.f0) / (2 * PEAK_PER_AMPLITUDE * PEAK_PER_AMPLITUDE) + 1e-12);
    dominance[t] = salienceDominance(S, t * nBins, nBins, tr.bin[t]);
    let total = 0;
    for (let k = K_START; k < shareTop; k++) total += V[t * K + k] * V[t * K + k];
    share[t] = total > 0 ? Math.min(1, r.power / total) : 0;
  }
  const voiced = applyLevelVoicing(f0, levelDb, HOP_SEC);
  const harmonicShare = medianOverVoiced(share, voiced);
  if (harmonicShare < MIN_HARMONIC_SHARE) voiced.fill(0); // no melody in this clip, only noise
  lap('refine+voicing');
  const refLevel = Float64Array.from(levelDb).sort()[Math.floor(0.9 * (nFrames - 1))];
  const confidence = new Float64Array(nFrames);
  for (let t = 0; t < nFrames; t++) {
    confidence[t] = 1 / (1 + Math.exp(-(CONF_DOMINANCE * dominance[t] + CONF_REL_LEVEL * (levelDb[t] - refLevel) + CONF_INTERCEPT)));
  }
  if (opts.dropFragments !== false) {
    const relLevelDb = Float64Array.from(levelDb, (v) => v - refLevel);
    dropFragments(f0, voiced, HOP_SEC, { confidence, relLevelDb, dominance, share });
  }
  const times = new Float64Array(nFrames);
  let voicedCount = 0;
  let confSum = 0;
  for (let t = 0; t < nFrames; t++) {
    times[t] = t * HOP_SEC;
    if (voiced[t]) {
      voicedCount++;
      confSum += confidence[t];
    } else f0[t] = NaN;
  }
  const track: PitchTrack = { sampleRate: sr, hopSec: HOP_SEC, times, f0, periodicity: confidence, rmsDb: levelDb, voiced };
  const result: VocalMelody = {
    track,
    confidence: voicedCount > 0 ? confSum / voicedCount : 0,
    sideToMidDb: R !== null && sideEnergy > 0 && midEnergy > 0 ? 10 * Math.log10(sideEnergy / midEnergy) : -Infinity,
    voicedSec: voicedCount * HOP_SEC,
    harmonicShare,
    cues: { dominance: Float32Array.from(dominance), share: Float32Array.from(share), levelRefDb: refLevel },
    timingsMs,
  };
  if (opts.withSignal) {
    result.vocalSignal = synthesizeVocal(L, R, V, K, f0, nFrames, sr, (f) => progress(0.9 + 0.1 * f));
    lap('signal');
  }
  return finish(result);
}

/** Median of x over the frames marked voiced (0 when none are). */
function medianOverVoiced(x: Float64Array, voiced: Uint8Array): number {
  const v: number[] = [];
  for (let t = 0; t < x.length; t++) if (voiced[t]) v.push(x[t]);
  if (v.length === 0) return 0;
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

/**
 * Salience of the chosen bin over (itself + the strongest rival), where a rival is a salience value
 * at least 1.5 semitones away that is not an octave or fifth relation of the chosen pitch.
 */
function salienceDominance(S: Float32Array, base: number, nBins: number, best: number): number {
  const octave = BINS_PER_OCTAVE;
  const related = [octave, -octave, Math.round(octave * Math.log2(3)), -Math.round(octave * Math.log2(3)), Math.round(octave * Math.log2(1.5)), -Math.round(octave * Math.log2(1.5))];
  let rival = 0;
  for (let j = 0; j < nBins; j++) {
    const d = j - best;
    if (d > -DOM_EXCLUDE_BINS && d < DOM_EXCLUDE_BINS) continue;
    let skip = false;
    for (let r = 0; r < related.length; r++) {
      if (Math.abs(d - related[r]) <= DOM_RELATED_TOL_BINS) {
        skip = true;
        break;
      }
    }
    if (!skip && S[base + j] > rival) rival = S[base + j];
  }
  const own = S[base + best];
  return own / (own + rival + 1e-20);
}

/** Linear interpolation of row `base` of V at fractional bin x (0 outside). */
function sampleSpectrum(V: Float32Array, base: number, K: number, x: number): number {
  if (x < 0 || x >= K - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  return V[base + i] * (1 - f) + V[base + i + 1] * f;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** bfloat16 (the top 16 bits of a float32; 3 significant digits is plenty for a level) round trip. */
function toBf16(x: number): number {
  f32[0] = x;
  return u32[0] >>> 16;
}
function fromBf16(h: number): number {
  u32[0] = h << 16;
  return f32[0];
}

/** Linear interpolation of a bfloat16 row at fractional bin x (0 outside). */
function sampleBf16(M: Uint16Array, base: number, K: number, x: number): number {
  if (x < 0 || x >= K - 1) return 0;
  const i = Math.floor(x);
  const f = x - i;
  return fromBf16(M[base + i]) * (1 - f) + fromBf16(M[base + i + 1]) * f;
}

/**
 * Harmonic power of the voicing copy of the spectrum, sum(W(h f)^2), W = V - (LEVEL_STRENGTH - STAT_STRENGTH) x M: the same
 * spectrum with the stationary part suppressed harder (V = raw - STAT_STRENGTH M, so W = raw - LEVEL_STRENGTH M).
 */
function levelPower(V: Float32Array, M: Uint16Array, base: number, K: number, binHz: number, f0: number): number {
  if (!(f0 > 0) || !Number.isFinite(f0)) return 0;
  const nH = Math.max(2, Math.min(REFINE_MAX_HARMONICS, Math.floor(REFINE_MAX_HZ / f0)));
  let power = 0;
  for (let h = 1; h <= nH; h++) {
    const x = (h * f0) / binHz;
    const w = sampleSpectrum(V, base, K, x) - (LEVEL_STRENGTH - STAT_STRENGTH) * sampleBf16(M, base, K, x);
    power += w > 0 ? w * w : 0;
  }
  return power;
}

/**
 * Harmonic-comb refinement of a coarse f0: the sum over harmonics of sqrt(V(h f)) is evaluated on a
 * 4 cent grid within +/-60 cents and the vertex of a parabola through the best three points is
 * taken. Returns the refined f0 and the harmonic power sum(V(h f)^2).
 */
export function refineF0(V: Float32Array, base: number, K: number, binHz: number, f0: number): { f0: number; power: number } {
  if (!(f0 > 0) || !Number.isFinite(f0)) return { f0, power: 0 };
  const nH = Math.max(2, Math.min(REFINE_MAX_HARMONICS, Math.floor(REFINE_MAX_HZ / f0)));
  const nC = Math.floor((2 * REFINE_RANGE_CENTS) / REFINE_STEP_CENTS) + 1;
  let best = -1;
  let bestI = 0;
  const vals = new Float64Array(nC);
  for (let ci = 0; ci < nC; ci++) {
    const f = f0 * Math.pow(2, (-REFINE_RANGE_CENTS + ci * REFINE_STEP_CENTS) / 1200);
    let s = 0;
    for (let h = 1; h <= nH; h++) s += Math.sqrt(sampleSpectrum(V, base, K, (h * f) / binHz));
    vals[ci] = s;
    if (s > best) {
      best = s;
      bestI = ci;
    }
  }
  let frac = 0;
  if (bestI > 0 && bestI < nC - 1) {
    const a = vals[bestI - 1];
    const b = vals[bestI];
    const c = vals[bestI + 1];
    const den = a - 2 * b + c;
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  const f = f0 * Math.pow(2, (-REFINE_RANGE_CENTS + (bestI + frac) * REFINE_STEP_CENTS) / 1200);
  let power = 0;
  for (let h = 1; h <= nH; h++) {
    const v = sampleSpectrum(V, base, K, (h * f) / binHz);
    power += v * v;
  }
  return { f0: f, power };
}

/** True when the pitch before the gap [a, b), inside it and after it all lie within VOICING_SAME_NOTE_SEMITONES of each other. */
function sameNote(f0: Float64Array, a: number, b: number, edge: number): boolean {
  const med = (from: number, to: number): number => {
    const v: number[] = [];
    for (let i = Math.max(0, from); i < Math.min(f0.length, to); i++) if (f0[i] > 0) v.push(f0[i]);
    if (v.length < Math.min(3, to - from)) return NaN;
    v.sort((x, y) => x - y);
    return v[v.length >> 1];
  };
  const before = med(a - edge, a);
  const inside = med(a, b);
  const after = med(b, b + edge);
  if (!(before > 0 && inside > 0 && after > 0)) return false;
  const st = (x: number, y: number) => Math.abs(12 * Math.log2(x / y));
  return st(before, inside) <= VOICING_SAME_NOTE_SEMITONES && st(after, inside) <= VOICING_SAME_NOTE_SEMITONES && st(before, after) <= VOICING_SAME_NOTE_SEMITONES;
}

/**
 * Level-based voicing. Smooth the harmonic level (dB) with a 5-frame median; the reference is its
 * 90th percentile over the clip. A frame turns voiced when its level is within VOICING_ENTER_DB of
 * the reference and unvoiced again when it falls VOICING_HYST_DB further; unvoiced gaps shorter
 * than 0.12 s are bridged (up to 0.4 s when the tracked pitch stays on one note across the dip) and voiced runs shorter than 0.2 s dropped (the shortest phrase analyze/phrases.ts keeps). On the proxy mixes the level
 * separated voiced from unvoiced frames with an AUC of 0.93, better than the salience value (0.79),
 * the share of harmonic energy that survives the suppression (0.86) or pitch-track stability.
 */
export function applyLevelVoicing(f0: Float64Array, levelDb: Float64Array, hopSec: number): Uint8Array {
  const n = f0.length;
  if (n === 0) return new Uint8Array(0);
  const sm = new Float64Array(n);
  const w: number[] = [];
  for (let t = 0; t < n; t++) {
    w.length = 0;
    for (let u = Math.max(0, t - 2); u <= Math.min(n - 1, t + 2); u++) w.push(levelDb[u]);
    w.sort((a, b) => a - b);
    sm[t] = w[w.length >> 1];
  }
  const sorted = Float64Array.from(sm).sort();
  const ref = sorted[Math.floor(0.9 * (n - 1))];
  const on = new Uint8Array(n);
  const enter = Math.max(ref - VOICING_ENTER_DB, VOICING_ABS_FLOOR_DB);
  const leave = Math.max(ref - VOICING_ENTER_DB - VOICING_HYST_DB, VOICING_ABS_FLOOR_DB - VOICING_HYST_DB);
  let state = 0;
  for (let t = 0; t < n; t++) {
    if (state === 0 && sm[t] >= enter) state = 1;
    else if (state === 1 && sm[t] < leave) state = 0;
    on[t] = state;
  }
  const maxGap = Math.round(VOICING_MAX_GAP_SEC / hopSec);
  let t = 0;
  while (t < n) {
    if (on[t]) {
      t++;
      continue;
    }
    let u = t;
    while (u < n && !on[u]) u++;
    if (t > 0 && u < n && u - t <= maxGap) on.fill(1, t, u);
    t = u;
  }
  // A level dip inside a held note (a straight note is suppressed as stationary, so its level sags): when the pitch the
  // tracker follows stays within a semitone across the whole dip, it is one note.
  const maxSame = Math.round(VOICING_SAME_NOTE_GAP_SEC / hopSec);
  t = 0;
  while (t < n) {
    if (on[t]) {
      t++;
      continue;
    }
    let u = t;
    while (u < n && !on[u]) u++;
    if (t > 0 && u < n && u - t <= maxSame && u - t > maxGap && sameNote(f0, t, u, VOICING_EDGE_FRAMES)) on.fill(1, t, u);
    t = u;
  }
  const minRun = Math.round(VOICING_MIN_RUN_SEC / hopSec);
  t = 0;
  while (t < n) {
    if (!on[t]) {
      t++;
      continue;
    }
    let u = t;
    while (u < n && on[u]) u++;
    if (u - t < minRun) on.fill(0, t, u);
    t = u;
  }
  return on;
}

/** Comb half-width around each harmonic, in units of f0; unvoiced frames keep this gain. */
const COMB_WIDTH = 0.35;
const UNVOICED_GAIN = 0.05;

/**
 * Inverse STFT of the mid spectrum times the gain V / |M| (the combined centre emphasis and
 * stationary suppression), times a raised-cosine comb around each harmonic of the tracked f0.
 * Hop 20 ms (the overlap-add normalises by the actual window overlap).
 */
function synthesizeVocal(
  L: Float32Array,
  R: Float32Array | null,
  V: Float32Array,
  K: number,
  f0: Float64Array,
  nFrames: number,
  sr: number,
  onProgress: (f: number) => void,
): Float32Array {
  const n = MELODY_FFT_SIZE;
  const half = n / 2;
  const binHz = sr / n;
  const fft = new FrameFft(n);
  const lre = new Float64Array(half + 1);
  const lim = new Float64Array(half + 1);
  const rre = new Float64Array(half + 1);
  const rim = new Float64Array(half + 1);
  const ola = new OverlapAdd(L.length, n);
  for (let t = 0; t < nFrames; t += 2) {
    const c = frameCentre(t, sr);
    fft.run(L, c, lre, lim);
    if (R !== null) {
      fft.run(R, c, rre, rim);
      for (let k = 0; k <= half; k++) {
        lre[k] = 0.5 * (lre[k] + rre[k]);
        lim[k] = 0.5 * (lim[k] + rim[k]);
      }
    }
    const f = f0[t];
    const voicedFrame = Number.isFinite(f);
    for (let k = 0; k <= half; k++) {
      let g = 0;
      if (k < K) {
        g = V[t * K + k] / (Math.hypot(lre[k], lim[k]) + 1e-20);
        if (g > 1) g = 1;
      }
      if (voicedFrame) {
        const fk = k * binHz;
        const h = Math.max(1, Math.round(fk / f));
        const d = Math.abs(fk - h * f);
        const w = COMB_WIDTH * f;
        g *= d >= w ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / w);
      } else g *= UNVOICED_GAIN;
      lre[k] *= g;
      lim[k] *= g;
    }
    ola.add(lre, lim, c);
    if ((t & 511) === 0) onProgress(t / nFrames);
  }
  return ola.finish();
}
