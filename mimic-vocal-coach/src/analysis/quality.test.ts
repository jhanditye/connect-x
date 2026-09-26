import { describe, expect, it } from 'vitest';
import { concat, mix, silence, synthMelody, whiteNoise } from '../testing/synth';
import { analyzeTake } from './analyze';
import { clippingRatio, qualityWarnings } from './quality';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
const melody = (amplitude = 0.5, seconds = 5) =>
  synthMelody(
    Array.from({ length: Math.round(seconds / 0.5) }, (_, i) => ({ midi: 55 + (i % 5), durSec: 0.5 })),
    { sampleRate: SR, amplitude },
  );

describe('clippingRatio', () => {
  it('counts samples at or beyond +/-0.999', () => {
    expect(clippingRatio(Float32Array.from([0, 0.5, 0.999, -1, 1.2, -0.3]))).toBeCloseTo(3 / 6, 5);
    expect(clippingRatio(new Float32Array(0))).toBe(0);
  });
});

describe('qualityWarnings', () => {
  it('is empty for a good recording', () => {
    expect(qualityWarnings({ voicedSec: 20, quality: { clippingRatio: 0, noiseFloorDb: -70, snrDb: 50 }, medianVoicedDb: -20 })).toEqual([]);
  });
});

describe('recording-quality warnings from analyzeTake', () => {
  it('a clean, well-levelled take has no warnings and a high SNR', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings).toEqual([]);
    expect(a.quality.clippingRatio).toBe(0);
    expect(a.quality.snrDb).toBeGreaterThan(40);
  });

  it('warns about too little singing', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(0.5, 1.5), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings.some((w) => /Record at least 10 seconds/.test(w))).toBe(true);
  });

  it('warns about clipping', () => {
    const loud = melody(1.6);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.max(-1, Math.min(1, loud[i]));
    const a = analyzeTake(concat(silence(0.5, SR), loud, silence(0.5, SR)), SR, OPTS);
    expect(a.quality.clippingRatio).toBeGreaterThan(0.001);
    expect(a.warnings.some((w) => /clipping/.test(w) && /lower the input gain/.test(w))).toBe(true);
  });

  it('warns about background noise', () => {
    const take = concat(silence(1, SR), melody(0.3), silence(1, SR));
    const noisy = mix(take, whiteNoise(take.length / SR, 0.02, SR));
    const a = analyzeTake(noisy, SR, OPTS);
    expect(a.quality.snrDb).toBeLessThan(20);
    expect(a.warnings.some((w) => /background noise/.test(w) && /quieter room/.test(w))).toBe(true);
  });

  it('warns about a very quiet recording', () => {
    const a = analyzeTake(concat(silence(0.5, SR), melody(0.01), silence(0.5, SR)), SR, OPTS);
    expect(a.warnings.some((w) => /very quiet/.test(w) && /closer to the microphone/.test(w))).toBe(true);
  });
});
