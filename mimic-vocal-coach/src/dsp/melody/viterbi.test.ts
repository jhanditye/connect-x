import { describe, expect, test } from 'vitest';
import { trackSalience } from './viterbi';

describe('trackSalience', () => {
  test('follows a continuous ridge and ignores a stronger single-frame distractor', () => {
    const nT = 100;
    const nBins = 200;
    const S = new Float32Array(nT * nBins);
    for (let t = 0; t < nT; t++) {
      const j = 80 + Math.round(t * 0.2);
      for (let d = -2; d <= 2; d++) S[t * nBins + j + d] = 1 - 0.2 * Math.abs(d);
    }
    S[50 * nBins + 150] = 3; // loud blip far away in one frame
    const { bin } = trackSalience(S, nT, nBins);
    for (let t = 0; t < nT; t++) expect(Math.abs(bin[t] - (80 + Math.round(t * 0.2)))).toBeLessThanOrEqual(1);
  });

  test('empty input gives empty output', () => {
    expect(trackSalience(new Float32Array(0), 0, 10).bin.length).toBe(0);
  });
});
