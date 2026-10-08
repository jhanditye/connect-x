// WSOLA time-stretch and pitch shift for a short mono phrase. Pitch is untouched by the stretch; the duration becomes
// length / rate. Used offline to pre-render the 90 / 75 / 60 % (and rough 50 %) versions of a phrase and a guide moved
// into the singer's key, because AudioBufferSourceNode.playbackRate changes pitch and Safari's preservesPitch path on a
// media element has had bugs (fixed only in Safari 27).
//
// The work is a resumable job (`createStretchJob`, `createGuideJob`): `run(budgetMs)` does as many frames as fit the
// budget and says whether it is finished, so the same code runs in one go (tests, a worker) or in slices on the main
// thread when no worker is available (`renderGuideAsync`). Nothing here touches the DOM or Web Audio.

import { resample } from './resample';

export interface StretchOptions {
  /** Analysis window in seconds. 25 ms covers >1 pitch period down to 65 Hz with room for the search. */
  windowSec?: number;
  /** +/- search for the best-fitting continuation, seconds. */
  toleranceSec?: number;
  /**
   * 'fast' (default): a coarse sweep on every 4th sample, then a fine search around the winner (about 7x less work).
   * 'exhaustive': every candidate at every second sample, the original reference search (slow; for tests).
   */
  search?: 'fast' | 'exhaustive';
}

/** Rates outside this range are a bug in the caller, not a request to render 40 minutes of audio. */
export const MIN_RATE = 0.1;
export const MAX_RATE = 10;
/** Two octaves either way is far past what a guide in the singer's key needs. */
export const MAX_SHIFT_SEMITONES = 24;

export interface StretchJob {
  /** Does frames until `budgetMs` of wall time is spent (Infinity: all of them). Returns true when the output is complete. */
  run(budgetMs: number): boolean;
  /** 0..1 */
  readonly progress: number;
  readonly done: boolean;
  /** The rendered samples; throws until `done`. */
  result(): Float32Array;
}

export interface GuideSpec {
  /** Playback speed, 0.1..10 (the app uses 0.5..1). Duration becomes length / rate. */
  rate: number;
  /** Pitch shift in semitones at constant duration (before the rate is applied), -24..24. */
  semitones: number;
  /** Sample rate of the output. Default: the input rate. The conversion is folded into the pitch-shift resample. */
  outRate?: number;
}

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

function checkFinitePositive(name: string, v: number, lo: number, hi: number): void {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new RangeError(`${name} must be between ${lo} and ${hi} (got ${v})`);
}

/** The input itself when every sample is finite, else a copy with NaN and Infinity replaced by silence. */
function sanitized(x: Float32Array): Float32Array {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) {
      const y = Float32Array.from(x);
      for (let k = i; k < y.length; k++) if (!Number.isFinite(y[k])) y[k] = 0;
      return y;
    }
  }
  return x;
}

function limited(y: Float32Array): Float32Array {
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    if (v > 1) y[i] = 1;
    else if (v < -1) y[i] = -1;
  }
  return y;
}

function finishedJob(out: Float32Array): StretchJob {
  return { run: () => true, progress: 1, done: true, result: () => out };
}

/**
 * A resumable WSOLA stretch. Input is never modified. `rate` 1 (within 1e-4) returns a copy at once.
 * Throws RangeError for a rate outside MIN_RATE..MAX_RATE or a sample rate that is not a positive number.
 */
export function createStretchJob(x: Float32Array, sampleRate: number, rate: number, opts: StretchOptions = {}): StretchJob {
  checkFinitePositive('rate', rate, MIN_RATE, MAX_RATE);
  checkFinitePositive('sampleRate', sampleRate, 1000, 384000);
  const src = sanitized(x);
  if (src.length === 0) return finishedJob(new Float32Array(0));
  if (Math.abs(rate - 1) < 1e-4) return finishedJob(limited(Float32Array.from(src)));

  const N = 2 * Math.max(4, Math.round(((opts.windowSec ?? 0.025) * sampleRate) / 2)); // even
  const Hs = N / 2; // synthesis hop (50 % overlap; the window sum is normalised below)
  const Ha = Hs * rate; // analysis hop
  const tol = Math.max(1, Math.round((opts.toleranceSec ?? 0.012) * sampleRate));
  const fast = (opts.search ?? 'fast') === 'fast';
  const outLen = Math.max(1, Math.round(src.length / rate));
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / N);
  // Zero padding after the signal lets every window read N + tol samples past a clamped start without bounds checks.
  const xp = new Float32Array(src.length + N + tol + 8);
  xp.set(src);
  const lastStart = src.length - N;
  const frames = Math.ceil(outLen / Hs) + 1;
  const tgt4 = new Float32Array(Math.ceil(Hs / 4));
  const tgt2 = new Float32Array(Math.ceil(Hs / 2));

  let f = 0;
  let outPos = 0;
  let readPos = 0; // nominal analysis position of the next frame
  let natural = 0; // where the natural continuation of the previous frame starts in the input
  let finished = false;
  let result: Float32Array | null = null;

  /** Normalised correlation of the target (decimated copy in `tgt`) with the input at `s`, sampling every `step`-th sample. */
  function score(tgt: Float32Array, step: number, s: number): number {
    let c = 0;
    let e = 1e-9;
    for (let k = 0, i = s; k < tgt.length; k++, i += step) {
      const b = xp[i];
      c += tgt[k] * b;
      e += b * b;
    }
    return c / Math.sqrt(e);
  }

  function fillTarget(tgt: Float32Array, step: number): void {
    for (let k = 0, i = natural; k < tgt.length; k++, i += step) tgt[k] = xp[i];
  }

  function bestStart(start: number): number {
    const lo = Math.max(0, start - tol);
    const hi = Math.min(lastStart, start + tol);
    if (hi < lo) return start;
    let best = start >= lo && start <= hi ? start : lo;
    let bestScore = -Infinity;
    if (fast) {
      fillTarget(tgt4, 4);
      for (let s = lo; s <= hi; s += 4) {
        const v = score(tgt4, 4, s);
        if (v > bestScore) {
          bestScore = v;
          best = s;
        }
      }
      fillTarget(tgt2, 2);
      const a = Math.max(lo, best - 3);
      const b = Math.min(hi, best + 3);
      bestScore = -Infinity;
      for (let s = a; s <= b; s++) {
        const v = score(tgt2, 2, s);
        if (v > bestScore) {
          bestScore = v;
          best = s;
        }
      }
    } else {
      fillTarget(tgt2, 2);
      for (let s = lo; s <= hi; s++) {
        const v = score(tgt2, 2, s);
        if (v > bestScore) {
          bestScore = v;
          best = s;
        }
      }
    }
    return best;
  }

  function frame(): void {
    let start = Math.round(readPos);
    if (f > 0) start = bestStart(start);
    start = Math.max(0, Math.min(src.length - 1, start));
    for (let i = 0; i < N; i++) {
      const w = win[i];
      out[outPos + i] += xp[start + i] * w;
      norm[outPos + i] += w;
    }
    natural = start + Hs;
    outPos += Hs;
    readPos += Ha;
    f++;
  }

  return {
    run(budgetMs: number): boolean {
      if (finished) return true;
      const timed = Number.isFinite(budgetMs);
      const deadline = timed ? now() + Math.max(0, budgetMs) : Infinity;
      let n = 0;
      while (f < frames && outPos < outLen) {
        frame();
        if (timed && (++n & 3) === 0 && now() >= deadline) break;
      }
      if (f >= frames || outPos >= outLen) {
        const res = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) res[i] = norm[i] > 1e-3 ? out[i] / norm[i] : 0;
        result = limited(res);
        finished = true;
      }
      return finished;
    },
    get progress(): number {
      return finished ? 1 : Math.min(0.999, f / frames);
    },
    get done(): boolean {
      return finished;
    },
    result(): Float32Array {
      if (!result) throw new Error('The stretch is not finished yet.');
      return result;
    },
  };
}

export function wsolaStretch(x: Float32Array, sampleRate: number, rate: number, opts: StretchOptions = {}): Float32Array {
  const job = createStretchJob(x, sampleRate, rate, opts);
  job.run(Infinity);
  return job.result();
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * The integer sample rate to resample to for a wanted (fractional) one. A pitch shift asks for rates like 63 871.4 Hz; rounding
 * to the integer within 0.05 % (under a cent) that shares the largest factor with the input rate gives a resampler with few
 * phases (a tiny filter table) whose output grid lines up every `m` input samples, so the work can be cut into slices.
 */
export function chooseResampleTarget(from: number, ideal: number): { to: number; m: number } {
  const base = Math.max(1, Math.round(ideal));
  if (!Number.isInteger(from) || Math.abs(ideal - base) < 1e-9) return { to: base, m: Number.isInteger(from) ? from / gcd(from, base) : from };
  const tol = Math.max(1, Math.floor(ideal * 0.0005));
  let best = { to: base, m: from / gcd(from, base) };
  for (let d = -tol; d <= tol; d++) {
    const t = base + d;
    if (t < 1000) continue;
    const m = from / gcd(from, t);
    if (m < best.m || (m === best.m && Math.abs(t - ideal) < Math.abs(best.to - ideal))) best = { to: t, m };
  }
  return best;
}

/** Kernel half-width in input samples never exceeds this for shifts within +-24 semitones (the filter is ~100 taps at 1:1, ~400 at 4:1). */
const RESAMPLE_MARGIN = 256;

/**
 * resample(x, from, to) cut into pieces of about 0.25 s so a main thread can interleave them with painting. The pieces start on
 * multiples of `m` input samples (where the output grid of `from -> to` repeats exactly) and carry a margin on each side, so
 * the stitched result equals one call over the whole signal up to rounding. Needs integer rates.
 */
export function createResampleJob(x: Float32Array, from: number, to: number, m: number): StretchJob {
  const outLen = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(outLen);
  const chunkIn = m * Math.max(1, Math.round((0.25 * from) / m));
  const margin = m * Math.ceil(RESAMPLE_MARGIN / m);
  const grid = to / from; // output samples per input sample: exact at multiples of m
  let a = 0;
  let finished = false;

  const step = (): void => {
    const last = a + chunkIn >= x.length;
    const b = last ? x.length : a + chunkIn;
    const lo = Math.max(0, a - margin);
    const hi = Math.min(x.length, b + margin);
    const piece = resample(x.subarray(lo, hi), from, to);
    const nlo = Math.round(lo * grid);
    const n0 = Math.round(a * grid);
    const n1 = last ? outLen : Math.round(b * grid);
    out.set(piece.subarray(n0 - nlo, Math.min(piece.length, n1 - nlo)), n0);
    a = b;
    if (last) finished = true;
  };

  return {
    run(budgetMs: number): boolean {
      const timed = Number.isFinite(budgetMs);
      const deadline = timed ? now() + Math.max(0, budgetMs) : Infinity;
      while (!finished) {
        step();
        if (timed && now() >= deadline) break;
      }
      return finished;
    },
    get progress(): number {
      return finished ? 1 : Math.min(0.999, a / Math.max(1, x.length));
    },
    get done(): boolean {
      return finished;
    },
    result(): Float32Array {
      if (!finished) throw new Error('The resample is not finished yet.');
      return out;
    },
  };
}

/**
 * A resumable render of a guide: optional pitch shift (by resampling, which also moves the pitch) and then a WSOLA stretch
 * to the wanted speed, in ONE stretch pass so the audio is processed once however many things were asked for. If `outRate`
 * differs from the input rate the sample-rate conversion rides on the same resample.
 */
export function createGuideJob(x: Float32Array, sampleRate: number, spec: GuideSpec, opts: StretchOptions = {}): StretchJob {
  checkFinitePositive('rate', spec.rate, MIN_RATE, MAX_RATE);
  checkFinitePositive('semitones', spec.semitones, -MAX_SHIFT_SEMITONES, MAX_SHIFT_SEMITONES);
  checkFinitePositive('sampleRate', sampleRate, 1000, 384000);
  const outRate = spec.outRate ?? sampleRate;
  checkFinitePositive('outRate', outRate, 1000, 384000);
  const shifted = Math.abs(spec.semitones) >= 1e-6;
  const f = shifted ? 2 ** (spec.semitones / 12) : 1;
  // Reading the content f times faster moves the pitch by f: resample to outRate / f, then call the result "outRate". The
  // integer target differs from the exact one by under 0.05 %, so the stretch uses the factor that was really applied.
  const target = chooseResampleTarget(sampleRate, outRate / f);
  const needsResample = target.to !== sampleRate;
  const stretchRate = spec.rate / (needsResample ? outRate / target.to : 1);
  const src = sanitized(x);

  let conv: StretchJob | null = null; // the resample, until it is done
  if (needsResample && src.length > 0) {
    if (Number.isInteger(sampleRate)) conv = createResampleJob(src, sampleRate, target.to, target.m);
    else {
      // A fractional input rate has no repeating grid: one call.
      let whole: Float32Array | null = null;
      conv = {
        run: () => ((whole ??= resample(src, sampleRate, target.to)), true),
        get progress() {
          return whole ? 1 : 0;
        },
        get done() {
          return !!whole;
        },
        result: () => whole as Float32Array,
      };
    }
  }
  let converted = src;
  let stretch: StretchJob | null = null;

  return {
    run(budgetMs: number): boolean {
      if (conv) {
        if (!conv.run(budgetMs)) return false;
        converted = conv.result();
        conv = null;
      }
      stretch ??= createStretchJob(converted, outRate, stretchRate, opts);
      return stretch.run(budgetMs);
    },
    get progress(): number {
      if (stretch) return 0.1 + 0.9 * stretch.progress;
      return conv ? 0.1 * conv.progress : 0;
    },
    get done(): boolean {
      return !!stretch && stretch.done;
    },
    result(): Float32Array {
      if (!stretch || !stretch.done) throw new Error('The render is not finished yet.');
      return stretch.result();
    },
  };
}

/** Renders a guide in one go (blocks for as long as it takes: use renderGuideAsync or the worker client on a main thread). */
export function renderGuide(x: Float32Array, sampleRate: number, spec: GuideSpec, opts: StretchOptions = {}): Float32Array {
  const job = createGuideJob(x, sampleRate, spec, opts);
  job.run(Infinity);
  return job.result();
}

/**
 * Shifts the pitch by `semitones` and keeps the duration: resample by 2^(n/12) (speeds the content up by f and
 * moves the pitch by f), then WSOLA back to the original length. Formants move with the pitch, which is fine for
 * a guide track. Fractions of a semitone are allowed.
 */
export function pitchShiftKeepDuration(x: Float32Array, sampleRate: number, semitones: number): Float32Array {
  if (!Number.isFinite(semitones) || Math.abs(semitones) < 1e-6) return limited(Float32Array.from(sanitized(x)));
  return renderGuide(x, sampleRate, { rate: 1, semitones });
}

export interface AsyncRenderOptions extends StretchOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Wall time per slice before handing the thread back. Default 8 ms (half a 60 Hz frame). */
  sliceMs?: number;
  /** Replaceable for tests: how the loop gives the thread back. Default setTimeout(0). */
  yieldFn?: () => Promise<void>;
}

export function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The render was cancelled.', 'AbortError');
  const err = new Error('The render was cancelled.');
  err.name = 'AbortError';
  return err;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Same result as renderGuide, in slices so the page keeps painting. Rejects with an AbortError when `signal` aborts. */
export async function renderGuideAsync(x: Float32Array, sampleRate: number, spec: GuideSpec, opts: AsyncRenderOptions = {}): Promise<Float32Array> {
  const job = createGuideJob(x, sampleRate, spec, opts);
  const slice = opts.sliceMs ?? 8;
  const pause = opts.yieldFn ?? yieldToEventLoop;
  if (opts.signal?.aborted) throw abortError();
  // The first slice also holds the resample, which cannot be split.
  while (!job.run(slice)) {
    opts.onProgress?.(job.progress);
    await pause();
    if (opts.signal?.aborted) throw abortError();
  }
  opts.onProgress?.(1);
  return job.result();
}
