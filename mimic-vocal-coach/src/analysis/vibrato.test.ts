import { describe, expect, it } from 'vitest';
import { concat, silence, synthVoice, type SynthOptions } from '../testing/synth';
import { analyzeTake } from './analyze';
import { fitVibrato, isVibrato } from './vibrato';

const SR = 22050;

function heldNote(opts: Partial<SynthOptions>, durationSec = 2) {
  const x = concat(silence(0.3, SR), synthVoice({ sampleRate: SR, durationSec, f0: 220, ...opts }), silence(0.3, SR));
  return analyzeTake(x, SR, { voiceType: 'baritone' });
}

describe('fitVibrato', () => {
  it('recovers rate and extent of a clean sinusoid on a drifting contour', () => {
    const times: number[] = [];
    const cents: number[] = [];
    for (let i = 0; i < 80; i++) {
      const t = i * 0.01;
      times.push(t);
      cents.push(30 * t + 50 * Math.sin(2 * Math.PI * 6.2 * t + 0.4));
    }
    const fit = fitVibrato(times, cents);
    expect(fit).not.toBeNull();
    expect(fit?.rateHz).toBeCloseTo(6.2, 1);
    expect(fit?.extentCents).toBeCloseTo(50, 0);
    expect(isVibrato(fit)).toBe(true);
  });

  it('rejects noise, tiny wobbles and too-short contours', () => {
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const times = Array.from({ length: 60 }, (_, i) => i * 0.01);
    expect(isVibrato(fitVibrato(times, times.map(() => 10 * rnd())))).toBe(false);
    expect(isVibrato(fitVibrato(times, times.map((t) => 6 * Math.sin(2 * Math.PI * 5.5 * t))))).toBe(false);
    expect(fitVibrato([0, 0.01, 0.02], [0, 1, 2])).toBeNull();
  });
});

describe('vibrato on synthesised notes', () => {
  it('5.5 Hz +/-40 cents: rate within 0.3 Hz, extent within 25 %', () => {
    const a = heldNote({ vibrato: { rateHz: 5.5, extentCents: 40 } });
    expect(a.notes).toHaveLength(1);
    const v = a.notes[0].vibrato;
    expect(v).not.toBeNull();
    expect(Math.abs((v?.rateHz ?? 0) - 5.5)).toBeLessThan(0.3);
    expect(Math.abs((v?.extentCents ?? 0) - 40)).toBeLessThan(10);
    expect(a.style.vibratoPresence).toBe(1);
    expect(a.style.vibratoRateHz).toBeCloseTo(5.5, 0);
  });

  it('7 Hz +/-80 cents is detected', () => {
    const v = heldNote({ vibrato: { rateHz: 7, extentCents: 80 } }).notes[0].vibrato;
    expect(v).not.toBeNull();
    expect(Math.abs((v?.rateHz ?? 0) - 7)).toBeLessThan(0.3);
    expect(Math.abs((v?.extentCents ?? 0) - 80)).toBeLessThan(20);
  });

  it('a straight tone with 1 % jitter has no vibrato', () => {
    const a = heldNote({ jitter: 0.01 });
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0].vibrato).toBeNull();
    expect(a.style.vibratoPresence).toBe(0);
    expect(a.style.vibratoRateHz).toBeNull();
  });

  it('handles delayed vibrato on a long note and ignores short notes', () => {
    const long = heldNote({ vibrato: { rateHz: 5, extentCents: 50, delaySec: 1 } }, 3.5);
    expect(long.notes[0].vibrato?.rateHz).toBeCloseTo(5, 0);
    const short = heldNote({ vibrato: { rateHz: 5.5, extentCents: 50 } }, 0.35);
    for (const n of short.notes) expect(n.vibrato).toBeNull();
    expect(short.style.vibratoPresence).toBeNull();
  });
});
