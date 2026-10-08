// Running median along one axis of a row-major (frame x bin) array, used to estimate the
// stationary background of a magnitude spectrogram: the median over time of each bin.
//
// The window slides over a sorted copy, so each step costs one binary-search removal and one
// insertion (about 2 * (log2 w + w / 2) element moves) instead of re-sorting w values.

/**
 * Median of the window [i - half, i + half] (clamped to the array) for every i, over a strided
 * 1-D signal src[offset + i * step], i = 0..count-1; results go to out[outOffset + i * outStep].
 * `w` is the full window length (odd). Near the ends the window shrinks.
 */
export function slidingMedian(
  src: Float32Array,
  offset: number,
  step: number,
  count: number,
  w: number,
  out: Float32Array,
  outOffset: number,
  outStep: number,
  scratch?: Float32Array,
): void {
  const half = w >> 1;
  const win = scratch && scratch.length >= w + 1 ? scratch : new Float32Array(w + 1);
  let len = 0;
  const lowerBound = (v: number): number => {
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (win[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < count; i++) {
    const wantLo = i - half > 0 ? i - half : 0;
    const wantHi = i + half < count - 1 ? i + half : count - 1;
    while (lo < wantLo) {
      const at = lowerBound(src[offset + lo * step]);
      win.copyWithin(at, at + 1, len);
      len--;
      lo++;
    }
    while (hi < wantHi) {
      hi++;
      const v = src[offset + hi * step];
      const at = lowerBound(v);
      win.copyWithin(at + 1, at, len);
      win[at] = v;
      len++;
    }
    out[outOffset + i * outStep] = win[len >> 1];
  }
}
