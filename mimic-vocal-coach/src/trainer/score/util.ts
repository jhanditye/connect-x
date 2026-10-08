import { clamp, median } from '../../dsp/stats';

export { clamp, median };

/**
 * Bell-shaped closeness, 1 inside the dead zone then a half-Gaussian fall-off.
 * `dead` is the error that is indistinguishable from measurement/natural variation; `sigma` the width of the fall-off
 * (score 0.61 at dead + sigma, 0.14 at dead + 2 sigma, 0.01 at dead + 3 sigma).
 */
export function bell(x: number, dead: number, sigma: number): number {
  const e = Math.max(0, Math.abs(x) - dead);
  return Math.exp(-0.5 * (e / sigma) ** 2);
}

export const mad = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
};

export function wmean(xs: number[], ws: number[]): number {
  let s = 0;
  let w = 0;
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i]) || !(ws[i] > 0)) continue;
    s += xs[i] * ws[i];
    w += ws[i];
  }
  return w > 0 ? s / w : NaN;
}

/** Weighted median. */
export function wmedian(xs: number[], ws: number[]): number {
  const idx = xs.map((_, i) => i).filter((i) => Number.isFinite(xs[i]) && ws[i] > 0).sort((a, b) => xs[a] - xs[b]);
  const total = idx.reduce((s, i) => s + ws[i], 0);
  if (total <= 0) return NaN;
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= total / 2) return xs[i];
  }
  return xs[idx[idx.length - 1]];
}

/** Theil-Sen line: median of pairwise slopes (pairs at least `minDx` apart), then median intercept. Robust to outliers. */
export function theilSen(xs: number[], ys: number[], minDx = 0.3): { slope: number; intercept: number; n: number } {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (Math.abs(xs[j] - xs[i]) >= minDx) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  const slope = slopes.length ? median(slopes) : 0;
  return { slope, intercept: median(ys.map((y, i) => y - slope * xs[i])), n: slopes.length };
}

/** Fold a difference in cents into [-600, 600]; returns the folded value and the number of octaves removed. */
export function foldOctave(cents: number): { folded: number; octaves: number } {
  const octaves = Math.round(cents / 1200);
  return { folded: cents - 1200 * octaves, octaves };
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

export const round = (x: number, d = 0): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
