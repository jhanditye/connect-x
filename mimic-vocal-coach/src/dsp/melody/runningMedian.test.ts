import { describe, expect, test } from 'vitest';
import { slidingMedian } from './runningMedian';

function naive(x: Float32Array, i: number, half: number): number {
  const a = Math.max(0, i - half);
  const b = Math.min(x.length - 1, i + half);
  const s = Array.from(x.subarray(a, b + 1)).sort((p, q) => p - q);
  return s[s.length >> 1];
}

describe('slidingMedian', () => {
  test('matches the naive median, including the shrinking edge windows', () => {
    const n = 200;
    const x = new Float32Array(n).map((_, i) => ((i * 7919) % 101) / 10);
    for (const w of [3, 7, 17, 51]) {
      const out = new Float32Array(n);
      slidingMedian(x, 0, 1, n, w, out, 0, 1);
      for (let i = 0; i < n; i++) expect(out[i]).toBeCloseTo(naive(x, i, w >> 1), 6);
    }
  });

  test('works along a strided column and leaves other columns alone', () => {
    const nT = 40;
    const K = 8;
    const x = new Float32Array(nT * K).map((_, i) => (i * 31) % 17);
    const out = new Float32Array(nT * K).fill(-1);
    slidingMedian(x, 3, K, nT, 5, out, 3, K);
    const col = Float32Array.from({ length: nT }, (_, t) => x[t * K + 3]);
    for (let t = 0; t < nT; t++) {
      expect(out[t * K + 3]).toBe(naive(col, t, 2));
      expect(out[t * K + 2]).toBe(-1);
    }
  });

  test('handles a window longer than the signal', () => {
    const x = Float32Array.from([5, 1, 3]);
    const out = new Float32Array(3);
    slidingMedian(x, 0, 1, 3, 11, out, 0, 1);
    expect(Array.from(out)).toEqual([3, 3, 3]);
  });
});
