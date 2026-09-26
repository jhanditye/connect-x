// Small NaN-aware statistics helpers. NaN marks "not measured" throughout the analysis code, so
// every function here skips NaN values instead of propagating them.

function finiteValues(xs: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (!Number.isNaN(v)) out.push(v);
  }
  return out;
}

/** Arithmetic mean, ignoring NaN. NaN if there are no values. */
export function mean(xs: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (!Number.isNaN(v)) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : NaN;
}

function sortedPercentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  // Linear interpolation between order statistics (same as numpy's default "linear" method).
  const rank = (clamp(p, 0, 100) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.min(n - 1, lo + 1);
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** p-th percentile (p in 0..100), ignoring NaN, linear interpolation between order statistics. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const v = finiteValues(xs);
  v.sort((a, b) => a - b);
  return sortedPercentile(v, p);
}

/** Median, ignoring NaN. NaN if there are no values. */
export function median(xs: ArrayLike<number>): number {
  return percentile(xs, 50);
}

/** Population standard deviation (divides by n), ignoring NaN. NaN if there are no values. */
export function std(xs: ArrayLike<number>): number {
  const m = mean(xs);
  if (Number.isNaN(m)) return NaN;
  let ss = 0;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (!Number.isNaN(v)) {
      ss += (v - m) * (v - m);
      n++;
    }
  }
  return Math.sqrt(ss / n);
}

/**
 * Ordinary least squares y = slope * x + intercept over pairs where neither value is NaN.
 * All NaN when fewer than two pairs or x has no spread. r2 is 1 when y is constant (a perfect fit).
 */
export function linearRegression(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
): { slope: number; intercept: number; r2: number } {
  const n0 = Math.min(xs.length, ys.length);
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n0; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    sx += x;
    sy += y;
    n++;
  }
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n0; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: NaN, intercept: NaN, r2: NaN };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

/**
 * Centred moving average over `window` samples (an even window is widened to the next odd size),
 * truncated at the edges. NaN inputs are skipped when averaging and stay NaN in the output, so
 * unvoiced gaps are preserved.
 */
export function movingAverage(xs: ArrayLike<number>, window: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  const half = Math.max(0, Math.floor(window / 2));
  // Prefix sums of values and of valid counts give O(n) regardless of window size.
  const sum = new Float64Array(n + 1);
  const cnt = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = xs[i];
    const ok = !Number.isNaN(v);
    sum[i + 1] = sum[i] + (ok ? v : 0);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
  }
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(xs[i])) {
      out[i] = NaN;
      continue;
    }
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (sum[hi] - sum[lo]) / (cnt[hi] - cnt[lo]);
  }
  return out;
}

/**
 * Centred running median over `window` samples (even windows widen to the next odd size),
 * truncated at the edges. NaN inputs are skipped and stay NaN in the output.
 */
export function medianFilter(xs: ArrayLike<number>, window: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  const half = Math.max(0, Math.floor(window / 2));
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(xs[i])) {
      out[i] = NaN;
      continue;
    }
    buf.length = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    for (let j = lo; j <= hi; j++) {
      const v = xs[j];
      if (!Number.isNaN(v)) buf.push(v);
    }
    buf.sort((a, b) => a - b);
    out[i] = sortedPercentile(buf, 50);
  }
  return out;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
