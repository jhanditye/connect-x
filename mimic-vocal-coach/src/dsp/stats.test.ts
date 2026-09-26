import { describe, expect, it } from 'vitest';
import { clamp, linearRegression, mean, median, medianFilter, movingAverage, percentile, std } from './stats';

describe('stats', () => {
  it('mean / median / std ignore NaN', () => {
    expect(mean([1, 2, NaN, 3])).toBe(2);
    expect(mean([])).toBeNaN();
    expect(mean([NaN])).toBeNaN();
    expect(median([5, 1, NaN, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median(new Float64Array([NaN, NaN]))).toBeNaN();
    expect(std([2, 4, 4, 4, 5, 5, 7, 9, NaN])).toBeCloseTo(2, 12);
    expect(std([])).toBeNaN();
  });

  it('percentile interpolates linearly between order statistics', () => {
    const xs = [10, 20, 30, 40, 50];
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 100)).toBe(50);
    expect(percentile(xs, 25)).toBe(20);
    expect(percentile(xs, 10)).toBeCloseTo(14, 12);
    expect(percentile([3, NaN, 1, 2], 50)).toBe(2);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  it('linearRegression fits a line and skips NaN pairs', () => {
    const r = linearRegression([0, 1, 2, 3, NaN], [1, 3, 5, 7, 100]);
    expect(r.slope).toBeCloseTo(2, 12);
    expect(r.intercept).toBeCloseTo(1, 12);
    expect(r.r2).toBeCloseTo(1, 12);
    const noisy = linearRegression([0, 1, 2, 3], [0, 1, 0, 1]);
    expect(noisy.r2).toBeGreaterThan(0);
    expect(noisy.r2).toBeLessThan(1);
    expect(linearRegression([1], [1]).slope).toBeNaN();
    expect(linearRegression([2, 2], [1, 3]).slope).toBeNaN();
  });

  it('movingAverage is centred, NaN-aware and preserves gaps', () => {
    const out = movingAverage([1, 2, 3, NaN, 5, 6], 3);
    expect(out[0]).toBeCloseTo(1.5, 12);
    expect(out[1]).toBeCloseTo(2, 12);
    expect(out[2]).toBeCloseTo(2.5, 12);
    expect(out[3]).toBeNaN();
    expect(out[4]).toBeCloseTo(5.5, 12);
    expect(out[5]).toBeCloseTo(5.5, 12);
  });

  it('medianFilter removes spikes and preserves gaps', () => {
    const out = medianFilter([1, 1, 9, 1, 1, NaN, 2], 3);
    expect(Array.from(out.subarray(0, 5))).toEqual([1, 1, 1, 1, 1]);
    expect(out[5]).toBeNaN();
    expect(out[6]).toBe(2);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});
