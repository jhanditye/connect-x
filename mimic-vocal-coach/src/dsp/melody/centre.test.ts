import { describe, expect, test } from 'vitest';
import { CENTRE_FLOOR, centreGain } from './centre';

describe('centreGain', () => {
  const K = 64;
  const run = (pm: Float64Array, ps: Float64Array) => {
    const g = new Float32Array(K);
    centreGain(pm, ps, K, new Float64Array(K), new Float64Array(K), g);
    return g;
  };

  test('a centre-panned partial (S = 0) passes, a wide one (|S| = |M|) drops to the floor', () => {
    const pm = new Float64Array(K).fill(1e-6);
    const ps = new Float64Array(K).fill(1e-6);
    pm[10] = 1;
    ps[10] = 0;
    pm[40] = 0.5;
    ps[40] = 0.5;
    const g = run(pm, ps);
    expect(g[10]).toBeGreaterThan(0.9);
    expect(g[40]).toBeCloseTo(CENTRE_FLOOR, 5);
  });

  test('gains stay within [floor, 1]', () => {
    const pm = new Float64Array(K).map((_, i) => 0.1 + (i % 7));
    const ps = new Float64Array(K).map((_, i) => (i % 5) * 0.9);
    for (const v of run(pm, ps)) {
      expect(v).toBeGreaterThanOrEqual(CENTRE_FLOOR - 1e-6);
      expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
});
