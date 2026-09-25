import { describe, expect, it } from 'vitest';
import { synthVoice, synthMelody, formantGain } from './synth';
import { encodeWav, decodeWav } from '../audio/wav';

describe('synthVoice', () => {
  it('is deterministic and peak-normalised', () => {
    const a = synthVoice({ durationSec: 0.5, f0: 220, seed: 1 });
    const b = synthVoice({ durationSec: 0.5, f0: 220, seed: 1 });
    expect(a).toEqual(b);
    const peak = a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeCloseTo(0.5, 5);
  });
  it('formant gain is 1 at DC and peaks near F1', () => {
    expect(formantGain(0, 'a')).toBeCloseTo(1, 6);
    expect(formantGain(730, 'a')).toBeGreaterThan(formantGain(300, 'a'));
  });
  it('melody has the summed duration', () => {
    const x = synthMelody([{ midi: 60, durSec: 0.3 }, { midi: 62, durSec: 0.2 }], { sampleRate: 22050 });
    expect(x.length).toBe(Math.round(0.5 * 22050));
  });
});

describe('wav', () => {
  it('round-trips 16-bit PCM', () => {
    const x = synthVoice({ durationSec: 0.2, f0: 196 });
    const back = decodeWav(encodeWav(x, 22050));
    expect(back.sampleRate).toBe(22050);
    expect(back.channels[0].length).toBe(x.length);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(back.channels[0][i] - x[i]));
    expect(maxErr).toBeLessThan(1e-4);
  });
});
