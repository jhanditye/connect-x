import { describe, expect, it } from 'vitest';
import { concat, silence, synthVoice, whiteNoise } from '../testing/synth';
import { analyzeTake } from './analyze';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
const tone = (attackSec: number, f0 = 196) => synthVoice({ sampleRate: SR, durationSec: 1, f0, attackSec });

function onsetOf(x: Float32Array) {
  const a = analyzeTake(concat(silence(0.3, SR), x, silence(0.3, SR)), SR, OPTS);
  expect(a.onsets).toHaveLength(1);
  return a.onsets[0];
}

describe('phrase onsets', () => {
  it('60 ms of breath noise before the tone is a breathy onset', () => {
    expect(onsetOf(concat(whiteNoise(0.06, 0.02, SR), tone(0.03))).type).toBe('breathy');
  });

  it('a 2 ms attack is a glottal onset', () => {
    expect(onsetOf(tone(0.002)).type).toBe('glottal');
    expect(onsetOf(tone(0.002, 131)).type).toBe('glottal');
  });

  it('an 80 ms swell is a balanced onset', () => {
    expect(onsetOf(tone(0.08)).type).toBe('balanced');
    expect(onsetOf(tone(0.03)).type).toBe('balanced');
  });

  it('reports the onset at the phrase start and the soft-onset ratio', () => {
    const x = concat(
      silence(0.3, SR),
      whiteNoise(0.06, 0.02, SR),
      tone(0.03),
      silence(0.5, SR),
      tone(0.002),
      silence(0.5, SR),
      whiteNoise(0.08, 0.015, SR, 9),
      tone(0.03),
      silence(0.3, SR),
    );
    const a = analyzeTake(x, SR, OPTS);
    expect(a.onsets.map((o) => o.type)).toEqual(['breathy', 'glottal', 'breathy']);
    expect(a.onsets[0].t).toBeCloseTo(a.phrases[0].start, 5);
    expect(a.style.softOnsetRatio).toBeCloseTo(2 / 3, 5);
  });
});
