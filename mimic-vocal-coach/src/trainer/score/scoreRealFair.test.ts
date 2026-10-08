// Real-voice checks for the fairness fixes (skipped cleanly when the clips are not on the machine; see realVoice.ts).
//  - slow practice: a real clip slowed with formant-preserving PSOLA to the chip speed is scored, not "did not match the phrase";
//  - pitch is read where the note was sung: +-50 cents injected on the long notes is read as roughly that, not as a third of it.
import { describe, expect, it } from 'vitest';
import { resample } from '../../dsp/resample';
import { concat, silence } from '../../testing/synth';
import { hasRealVoice, loadRealVoice } from './realVoice';
import { scoreAttempt } from './score';
import { SR, analyse, centsToFactor, psolaHQ, roomNoise } from './testkit';

describe('slow practice on a real clip', () => {
  it.skipIf(!hasRealVoice('long_voice.wav'))('a 12 s clip slowed to 75 %, 60 % and 50 % scores, exactly at that speed and 10 % slower', () => {
    const w = loadRealVoice('long_voice.wav', 12);
    const x = resample(w.samples, w.sampleRate, SR);
    const dur = x.length / SR;
    const ref = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)), 'baritone');
    for (const rate of [0.75, 0.6, 0.5]) {
      for (const err of [1, 1.1]) {
        const f = err / rate;
        const y = psolaHQ(x, { durationSec: dur * f, timeMap: (t) => t / f, pitchFactor: () => 1 });
        const att = analyse(roomNoise(concat(silence(1.6, SR), y, silence(0.6, SR)), 0.0012, 5), 'baritone');
        const r = scoreAttempt(ref, att, { rate, mode: 'turn-taking' });
        expect(r.status, `rate ${rate} x${err}`).toBe('ok');
        expect(r.overall as number, `rate ${rate} x${err}`).toBeGreaterThanOrEqual(85);
        expect(r.skills.pitch as number, `rate ${rate} x${err}`).toBeGreaterThanOrEqual(90);
      }
    }
  }, 180_000);
});

describe('pitch is read where the note was sung', () => {
  for (const file of ['long_voice.wav', 'vocadito10.wav']) {
    it.skipIf(!hasRealVoice(file))(`${file}: +-50 cents on the long notes is read as at least 35 cents on average, and is not a "very close" pitch`, () => {
      const w = loadRealVoice(file, 12);
      const x = resample(w.samples, w.sampleRate, SR);
      const dur = x.length / SR;
      const ref = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)), 'baritone');
      const long = ref.notes.map((n, k) => ({ n, k })).filter(({ n }) => n.end - n.start >= 0.3);
      const off = new Map<number, number>();
      long.forEach(({ k }, i) => off.set(k, (i % 2 ? -1 : 1) * 50));
      const offAt = (t: number): number => {
        const tt = t + 0.15;
        const hit = long.find(({ n }) => tt >= n.start && tt < n.end);
        return hit ? (off.get(hit.k) as number) : 0;
      };
      const y = psolaHQ(x, { durationSec: dur, timeMap: (t) => t, pitchFactor: (t) => centsToFactor(offAt(t)) });
      const att = analyse(roomNoise(concat(silence(1.6, SR), y, silence(0.6, SR)), 0.0012, 5), 'baritone');
      const r = scoreAttempt(ref, att);
      expect(r.status).toBe('ok');
      const read = long.map(({ k }) => r.perNote[k].cents).filter((c): c is number => c !== null).map(Math.abs);
      expect(read.length).toBeGreaterThanOrEqual(3);
      const mean = read.reduce((a, b) => a + b, 0) / read.length;
      expect(mean).toBeGreaterThanOrEqual(35);
      expect(r.skills.pitch as number).toBeLessThanOrEqual(80);
    }, 120_000);
  }

  it.skipIf(!hasRealVoice('long_voice.wav'))('an identical copy through the same PSOLA path is still read as in tune (no cents invented)', () => {
    const w = loadRealVoice('long_voice.wav', 12);
    const x = resample(w.samples, w.sampleRate, SR);
    const dur = x.length / SR;
    const ref = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)), 'baritone');
    const y = psolaHQ(x, { durationSec: dur, timeMap: (t) => t, pitchFactor: () => 1 });
    const r = scoreAttempt(ref, analyse(roomNoise(concat(silence(1.6, SR), y, silence(0.6, SR)), 0.0012, 5), 'baritone'));
    expect(r.status).toBe('ok');
    expect(r.skills.pitch as number).toBeGreaterThanOrEqual(97);
    const read = r.perNote.map((n) => n.cents).filter((c): c is number => c !== null).map(Math.abs);
    expect(Math.max(...read)).toBeLessThan(25);
  }, 60_000);
});
