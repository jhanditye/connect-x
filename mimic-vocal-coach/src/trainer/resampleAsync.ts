// Sample-rate conversion in slices, so the page stays responsive. dsp/resample.ts converts a 5-minute 96 kHz file in 4 s on a
// desktop (several times that on a phone) in ONE call, which freezes every tap and the progress bar. Each output sample depends
// only on the input around it, so the file is converted a slice at a time (each slice starts on a whole number of input samples that
// maps onto a whole number of output samples, with the filter's reach on both sides) and the page gets a turn between slices.
// The result is the same numbers resample() gives for the whole signal.

import { resample } from '../dsp/resample';
import { abortError } from '../analysis/abort';

/** Output samples per slice: about 8 ms of work on a desktop. */
const SLICE_OUTPUTS = 24576;
/** Input samples kept on each side of a slice: more than the longest filter reach (200 samples at 192 kHz -> 48 kHz). */
const MARGIN_INPUTS = 2048;
/** Below this many output samples one call is quick enough. */
const SMALL = 48000;

export interface ResampleAsyncOptions {
  signal?: AbortSignal;
  /** 0..1, called when the page is given a turn. */
  onProgress?: (fraction: number) => void;
  /** How long to work before giving the page a turn, ms (default 10). */
  sliceMs?: number;
  /** Test seams. */
  now?: () => number;
  yieldToPage?: () => Promise<void>;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function resampleAsync(x: Float32Array, fromRate: number, toRate: number, opts: ResampleAsyncOptions = {}): Promise<Float32Array> {
  if (opts.signal?.aborted) throw abortError('The import was cancelled.');
  const outLen = Math.max(1, Math.round((x.length * toRate) / fromRate));
  const g = Number.isInteger(fromRate) && Number.isInteger(toRate) && fromRate > 0 && toRate > 0 ? gcd(fromRate, toRate) : 0;
  const l = g ? toRate / g : 0;
  const m = g ? fromRate / g : 0;
  // Rates that do not reduce to a small ratio (or a signal this short) are converted in one call, as before.
  if (fromRate === toRate || x.length === 0 || outLen <= SMALL || !g || l > 4096) return resample(x, fromRate, toRate);

  const out = new Float32Array(outLen);
  const q = Math.max(1, Math.round(SLICE_OUTPUTS / l));
  const chunkOut = l * q; // output samples per slice
  const margin = Math.ceil(MARGIN_INPUTS / m) * m; // a whole number of input steps, so every slice starts on a whole output sample
  const now = opts.now ?? defaultNow;
  const yieldToPage = opts.yieldToPage ?? defaultYield;
  const sliceMs = opts.sliceMs ?? 10;
  let since = now();
  for (let n0 = 0; n0 < outLen; n0 += chunkOut) {
    const inStart = (n0 / l) * m;
    const s = Math.max(0, inStart - margin);
    const outStart = (s / m) * l; // the output sample that input sample s maps onto
    const e = Math.min(x.length, inStart + q * m + margin);
    const part = resample(x.subarray(s, e), fromRate, toRate);
    const count = Math.min(chunkOut, outLen - n0);
    out.set(part.subarray(n0 - outStart, n0 - outStart + count), n0);
    if (now() - since >= sliceMs) {
      opts.onProgress?.((n0 + count) / outLen);
      await yieldToPage();
      if (opts.signal?.aborted) throw abortError('The import was cancelled.');
      since = now();
    }
  }
  opts.onProgress?.(1);
  return out;
}
