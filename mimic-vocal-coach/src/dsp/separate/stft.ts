// Spleeter-style STFT / inverse STFT of one channel, built on the project FFT (../fft) and its inverse real FFT
// (../melody/stft irfft).
//
// Frame layout (identical to Spleeter's TensorFlow graph, spleeter/model/__init__.py _build_stft_feature):
//   - `frameLength` zeros are put in front of the signal, so padded index q = frameLength + signal index;
//   - frame i covers padded samples [i * frameStep, i * frameStep + frameLength) (no centring, no reflection);
//   - the end is padded with zeros ("pad_end"), giving ceil((frameLength + length) / frameStep) frames;
//   - the window is a periodic Hann; the forward transform is not scaled (the same convention as tf.signal.stft,
//     so a unit sine on a bin centre has magnitude frameLength / 4).
//
// The lead-in of one frame length guarantees that every real sample is covered by frameLength / frameStep frames,
// so the inverse (window, overlap-add, divide by the summed squared window) is exact from the very first sample
// to the very last one, not only away from the edges.

import { hann, rfft } from '../fft';
import { irfft } from '../melody/stft';

export interface StftGeometry {
  frameLength: number;
  frameStep: number;
}

/** Number of frames for a signal of `length` samples (0 for an empty signal). */
export function stftFrameCount(length: number, g: StftGeometry): number {
  return length > 0 ? Math.ceil((g.frameLength + length) / g.frameStep) : 0;
}

/** Windowed forward transform of single frames of a real signal. Keeps scratch buffers, so reuse one per geometry. */
export class FrameAnalyser {
  readonly frameLength: number;
  readonly frameStep: number;
  readonly window: Float64Array;
  private readonly buf: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(g: StftGeometry) {
    this.frameLength = g.frameLength;
    this.frameStep = g.frameStep;
    this.window = hann(g.frameLength);
    this.buf = new Float64Array(g.frameLength);
    this.re = new Float64Array(g.frameLength / 2 + 1);
    this.im = new Float64Array(g.frameLength / 2 + 1);
  }

  /**
   * Transform frames [first, first + count) of `x` and write the lowest `bins` bins of each, frame-major
   * ([frame][bin]), into outRe/outIm starting at frame slot `slot`. Samples outside `x` are zero, so frames past the
   * end of the signal come out as zeros.
   */
  frames(
    x: ArrayLike<number>,
    first: number,
    count: number,
    bins: number,
    outRe: Float32Array,
    outIm: Float32Array,
    slot = 0,
  ): void {
    const { frameLength: n, frameStep, window: win, buf, re, im } = this;
    const len = x.length;
    for (let k = 0; k < count; k++) {
      const start = (first + k) * frameStep - n; // signal index of the frame's first sample
      if (start >= 0 && start + n <= len) {
        for (let j = 0; j < n; j++) buf[j] = x[start + j] * win[j];
      } else {
        for (let j = 0; j < n; j++) {
          const idx = start + j;
          buf[j] = idx >= 0 && idx < len ? x[idx] * win[j] : 0;
        }
      }
      rfft(buf, n, re, im);
      const o = (slot + k) * bins;
      for (let b = 0; b < bins; b++) {
        outRe[o + b] = re[b];
        outIm[o + b] = im[b];
      }
    }
  }
}

/**
 * Overlap-add inverse STFT into a signal of fixed length. Add every frame 0..frameCount-1 exactly once (in any
 * order), then call finish(), which divides by the summed squared window and returns the signal.
 */
export class FrameSynthesiser {
  readonly out: Float32Array;
  private readonly frameLength: number;
  private readonly frameStep: number;
  private readonly window: Float64Array;
  private readonly buf: Float64Array;
  /** 1 / sum over overlapping frames of window^2, by position within a hop. */
  private readonly invNorm: Float64Array;

  constructor(length: number, g: StftGeometry) {
    this.out = new Float32Array(length);
    this.frameLength = g.frameLength;
    this.frameStep = g.frameStep;
    this.window = hann(g.frameLength);
    this.buf = new Float64Array(g.frameLength);
    const norm = new Float64Array(g.frameStep);
    for (let j = 0; j < g.frameStep; j++) {
      for (let q = j; q < g.frameLength; q += g.frameStep) norm[q % g.frameStep] += this.window[q] * this.window[q];
    }
    this.invNorm = norm.map((v) => (v > 1e-9 ? 1 / v : 0));
  }

  /** Add the frame with half-spectrum (re, im) = bins 0..frameLength/2 (at least; extra values are ignored). */
  add(frame: number, re: ArrayLike<number>, im: ArrayLike<number>): void {
    const { frameLength: n, frameStep, window: win, buf, out } = this;
    irfft(re, im, n, buf);
    const start = frame * frameStep - n;
    const len = out.length;
    const lo = Math.max(0, -start);
    const hi = Math.min(n, len - start);
    for (let j = lo; j < hi; j++) out[start + j] += buf[j] * win[j];
  }

  finish(): Float32Array {
    const { out, frameStep, frameLength, invNorm } = this;
    // Position i of the signal is padded index frameLength + i; frameLength is a multiple of frameStep.
    for (let i = 0; i < out.length; i++) out[i] *= invNorm[(i + frameLength) % frameStep];
    return out;
  }
}

export interface Spectrogram {
  /** [frame][bin], frames x bins. */
  re: Float32Array;
  im: Float32Array;
  frames: number;
  bins: number;
}

/** Whole-signal forward STFT keeping the lowest `bins` bins (default: all frameLength/2 + 1). */
export function stft(x: ArrayLike<number>, g: StftGeometry, bins = g.frameLength / 2 + 1): Spectrogram {
  const frames = stftFrameCount(x.length, g);
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  new FrameAnalyser(g).frames(x, 0, frames, bins, re, im);
  return { re, im, frames, bins };
}

/** Whole-signal inverse STFT of `spec` (bins above spec.bins are zero) to a signal of `length` samples. */
export function istft(spec: Spectrogram, g: StftGeometry, length: number): Float32Array {
  const synth = new FrameSynthesiser(length, g);
  const half = g.frameLength / 2 + 1;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  const keep = Math.min(spec.bins, half);
  for (let t = 0; t < spec.frames; t++) {
    const o = t * spec.bins;
    for (let b = 0; b < keep; b++) {
      re[b] = spec.re[o + b];
      im[b] = spec.im[o + b];
    }
    synth.add(t, re, im);
  }
  return synth.finish();
}
