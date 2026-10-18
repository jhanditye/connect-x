import { describe, expect, it } from 'vitest';
import { concat } from '../../testing/synth';
import { scoreHiss, scoreLongTone } from './index';
import { babble, hiss, roomNoise, singContour, SR } from './fixtures';

const room = (s: number, seed = 11) => roomNoise(s, SR, seed);

describe('scoreHiss', () => {
  it('measures a 10 s hiss after 0.6 s of room noise as 10 +/- 0.5 s, very steady', () => {
    const x = concat(room(0.6), hiss(10), room(1, 12));
    const s = scoreHiss(x, SR);
    expect(s.status).toBe('ok');
    expect(Math.abs(s.durationSec - 10)).toBeLessThanOrEqual(0.5);
    expect(s.startSec as number).toBeCloseTo(0.6, 1);
    expect(s.steadinessDb as number).toBeLessThan(1.5);
    expect(s.noiseFloorDb).toBeLessThan(-55);
    expect(s.levelTrace.length).toBeGreaterThan(90);
    expect(s.findings[0].text).toMatch(/^10\.\d seconds of hiss on one breath, very steady/);
  });

  it('measures a 3 s hiss as 3 +/- 0.2 s, also with room noise under it and at 48 kHz', () => {
    const s = scoreHiss(concat(room(0.6), hiss(3), room(0.8, 12)), SR);
    expect(Math.abs(s.durationSec - 3)).toBeLessThanOrEqual(0.2);
    const noisy = new Float32Array(Math.round(4.4 * SR));
    noisy.set(hiss(3), Math.round(0.6 * SR));
    const bed = roomNoise(4.4, SR, 13, 0.003);
    for (let i = 0; i < noisy.length; i++) noisy[i] += bed[i];
    expect(Math.abs(scoreHiss(noisy, SR).durationSec - 3)).toBeLessThanOrEqual(0.2);
    const hi = scoreHiss(concat(roomNoise(0.6, 48000), hiss(3, 0.03, 48000), roomNoise(0.8, 48000, 12)), 48000);
    expect(Math.abs(hi.durationSec - 3)).toBeLessThanOrEqual(0.2);
  });

  it('still finds the room floor when the hiss starts the instant capture opens', () => {
    const s = scoreHiss(concat(hiss(8), room(0.8, 12)), SR);
    expect(s.status).toBe('ok');
    expect(Math.abs(s.durationSec - 8)).toBeLessThanOrEqual(0.3);
  });

  it('bridges a short catch in the airflow but not a new breath', () => {
    const catchy = scoreHiss(concat(room(0.6), hiss(2), room(0.2, 14), hiss(2, 0.03, SR, 6), room(0.8, 12)), SR);
    expect(catchy.durationSec).toBeGreaterThan(4);
    expect(catchy.steadinessDb as number).toBeLessThan(1.5);
    const twoBreaths = scoreHiss(concat(room(0.6), hiss(2), room(1, 14), hiss(3, 0.03, SR, 6), room(0.8, 12)), SR);
    expect(Math.abs(twoBreaths.durationSec - 3)).toBeLessThanOrEqual(0.2);
  });

  it('calls an uneven hiss uneven', () => {
    const s = scoreHiss(concat(room(0.6), hiss(6, 0.03, SR, 5, 6), room(0.8, 12)), SR);
    expect(s.status).toBe('ok');
    expect(s.steadinessDb as number).toBeGreaterThan(3);
    expect(s.findings.some((f) => f.tone === 'work')).toBe(true);
  });

  it('does not score a sung vowel, room noise, silence or speech-like babble as a hiss', () => {
    expect(scoreHiss(singContour(57, 3, () => 0), SR).status).toBe('voiced');
    const r = scoreHiss(room(4), SR);
    expect(r.status).toBe('too-quiet');
    expect(r.durationSec).toBe(0);
    expect(scoreHiss(new Float32Array(SR * 2), SR).status).toBe('too-quiet');
    const b = scoreHiss(babble(4), SR);
    expect(b.status).not.toBe('ok');
    expect(b.steadinessDb).toBeNull();
  });
});

describe('scoreLongTone', () => {
  it('a few frames read an octave and more away do not turn a steady tone "wobbly"', () => {
    // 8 s steady A3 with 0.2 s that reads 19 semitones low (as a tracker slip on a soft tone in a noisy room would).
    const s = scoreLongTone(singContour(57, 8, (t) => (t > 3 && t < 3.2 ? -1940 : 0)), SR, { a4Hz: 440 });
    expect(s.status).toBe('ok');
    expect(s.pitchSdCents as number).toBeLessThan(12);
    expect(s.findings[0].text).not.toMatch(/wobbly/);
  });

  it('a natural taper over the last second is not called uneven volume', () => {
    const x = singContour(57, 6, () => 0);
    const n = x.length;
    // The synthetic take has 0.4 s of room before and after: fade the last 0.8 s of the voice by up to -20 dB.
    const end = n - Math.round(0.4 * SR);
    const fade = Math.round(0.8 * SR);
    for (let i = end - fade; i < end; i++) x[i] *= Math.pow(10, (-20 * (i - (end - fade))) / fade / 20);
    const s = scoreLongTone(x, SR, { a4Hz: 440 });
    expect(s.loudnessSdDb as number).toBeLessThan(3);
    expect(s.findings.some((f) => /volume varied/.test(f.text))).toBe(false);
  });

  it('measures duration and steadiness of a steady 8 s tone with vibrato (vibrato not counted)', () => {
    const s = scoreLongTone(singContour(57, 8, () => 0), SR, { a4Hz: 440 });
    expect(s.status).toBe('ok');
    expect(Math.abs(s.durationSec - 8)).toBeLessThan(0.2);
    expect(s.pitchSdCents as number).toBeLessThan(10);
    expect(s.loudnessSdDb as number).toBeLessThan(1.5);
    expect(s.midi as number).toBeCloseTo(57, 1);
    expect(s.pitchTrace.length).toBeGreaterThan(70);
    expect(s.findings[0].text).toMatch(/^8\.\d seconds, pitch very steady/);
  });

  it('calls a slow +/-40 cent wander wobbly, and bridges a short dropout', () => {
    const w = scoreLongTone(singContour(57, 6, (t) => 40 * Math.sin(2 * Math.PI * 1 * t)), SR, { a4Hz: 440 });
    expect(w.pitchSdCents as number).toBeGreaterThan(20);
    expect(w.findings[0].tone).toBe('work');
    // A 100 ms dropout in the middle of a 6 s tone is bridged; a 0.5 s break is not.
    const tone = singContour(57, 6, () => 0);
    const cut = (sec: number) => {
      const y = Float32Array.from(tone);
      y.fill(0, Math.round(3.4 * SR), Math.round((3.4 + sec) * SR));
      return y;
    };
    expect(scoreLongTone(cut(0.1), SR, { a4Hz: 440 }).durationSec).toBeGreaterThan(5.8);
    expect(scoreLongTone(cut(0.5), SR, { a4Hz: 440 }).durationSec).toBeLessThan(3.2);
  });

  it('reports too-quiet instead of a duration', () => {
    const s = scoreLongTone(room(3), SR, { a4Hz: 440 });
    expect(s.status).toBe('too-quiet');
    expect(s.pitchSdCents).toBeNull();
  });
});
