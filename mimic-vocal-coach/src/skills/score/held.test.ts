import { describe, expect, it } from 'vitest';
import type { HeldNoteScore, LiveReading, RegisterThird } from '../types';
import { centsMeaning, createLockTracker, formatCents, scoreHeldNote, summarisePitchTest } from './index';
import { MINUS as CHART_MINUS } from '../../ui/charts/chartKit';
import { MINUS } from './format';
import { babble, hiss, inRoom, roomNoise, singContour, SR } from './fixtures';

const baritone = { lowMidi: 45, highMidi: 65 };
const soprano = { lowMidi: 57, highMidi: 74 };
const opts = (range = baritone, toleranceCents = 25) => ({ a4Hz: 440, toleranceCents, range });

describe('scoreHeldNote on the synthetic singer (vibrato 5.5 Hz +/-40, jitter 0.5 %, breath 0.1)', () => {
  it('scores an in-tune singer within 5 cents, male and female ranges', () => {
    for (const [midi, range] of [
      [45, baritone],
      [52, baritone],
      [57, baritone],
      [64, baritone],
      [60, soprano],
      [72, soprano],
    ] as const) {
      const s = scoreHeldNote(singContour(midi, 2.2, () => 0), SR, midi, opts(range));
      expect(s.status).toBe('ok');
      expect(Math.abs(s.heldCents as number)).toBeLessThan(5);
      expect(s.within).toBe(true);
      expect(s.octaveOffset).toBe(0);
      expect(s.timeToLandSec).not.toBeNull();
    }
  });

  it('measures a +30 cent detune as 30 +/- 5 and a -30 cent one as -30 +/- 5', () => {
    const up = scoreHeldNote(singContour(57, 2.2, () => 30), SR, 57, opts());
    expect(up.heldCents as number).toBeGreaterThan(25);
    expect(up.heldCents as number).toBeLessThan(35);
    expect(up.within).toBe(false);
    expect(up.timeToLandSec).toBeNull();
    const down = scoreHeldNote(singContour(50, 2.2, () => -30), SR, 50, opts());
    expect(down.heldCents as number).toBeGreaterThan(-35);
    expect(down.heldCents as number).toBeLessThan(-25);
  });

  it('is not biased by a wide 6 Hz +/-50 cent vibrato (held within 5 cents, vibrato not counted as instability)', () => {
    for (const rate of [4.5, 6, 7]) {
      const s = scoreHeldNote(singContour(55, 2.2, () => 0, { vibrato: { rateHz: rate, extentCents: 50 } }), SR, 55, opts());
      expect(Math.abs(s.heldCents as number)).toBeLessThan(5);
      expect(s.stabilityCents as number).toBeLessThan(12);
    }
  });

  it('separates a flat landing from the held pitch, and a quick scoop shows in the time to land', () => {
    // Glide in from -150, settle at -60 for 250 ms, correct up to the note over 200 ms, hold.
    const flatLanding = (t: number) => (t < 0.12 ? -150 + 750 * t : t < 0.37 ? -60 : t < 0.57 ? -60 + 300 * (t - 0.37) : 0);
    const s = scoreHeldNote(singContour(57, 2.4, flatLanding), SR, 57, opts());
    expect(s.landingCents as number).toBeLessThan(-50);
    expect(Math.abs(s.heldCents as number)).toBeLessThan(5);
    expect(s.timeToLandSec as number).toBeGreaterThan(0.4);
    expect(s.findings.some((f) => /slid up/.test(f.text))).toBe(true);
    // A 150-cent linear scoop over 120 ms: held is unaffected; the landing (mean of the first 200 ms from the onset)
    // carries the scoop (-33.5 measured), and the scoop finding fires.
    const scoop = scoreHeldNote(singContour(57, 2.2, (t) => (t < 0.12 ? -150 + 1250 * t : 0)), SR, 57, opts());
    expect(Math.abs(scoop.heldCents as number)).toBeLessThan(5);
    expect(scoop.landingCents as number).toBeLessThan(-30);
    expect(scoop.landingCents as number).toBeGreaterThan(-60);
    expect(scoop.findings.some((f) => /slid up/.test(f.text))).toBe(true);
    expect(scoop.timeToLandSec as number).toBeGreaterThan(0.05);
    expect(scoop.timeToLandSec as number).toBeLessThan(0.35);
  });

  it('judges an octave error on pitch class and says so', () => {
    const s = scoreHeldNote(singContour(45, 2.2, () => 0), SR, 57, opts());
    expect(s.octaveOffset).toBe(-1);
    expect(Math.abs(s.heldCents as number)).toBeLessThan(5);
    expect(s.within).toBe(true);
    expect(s.findings[0].text).toMatch(/Right note, one octave lower/);
    const hi = scoreHeldNote(singContour(69, 2.2, () => 0), SR, 57, opts());
    expect(hi.octaveOffset).toBe(1);
    expect(Math.abs(hi.heldCents as number)).toBeLessThan(5);
  });

  it('copes with a breathy voice and a low bass note', () => {
    const breathy = scoreHeldNote(singContour(60, 2.2, () => 0, { breathNoise: 0.6 }), SR, 60, opts());
    expect(breathy.status).toBe('ok');
    expect(Math.abs(breathy.heldCents as number)).toBeLessThan(6);
    const bass = scoreHeldNote(singContour(41, 2.2, () => 0, { tiltDbPerOct: -9 }), SR, 41, opts({ lowMidi: 41, highMidi: 62 }));
    expect(Math.abs(bass.heldCents as number)).toBeLessThan(5);
    expect(bass.octaveOffset).toBe(0);
  });

  it('works at 48 kHz', () => {
    const s = scoreHeldNote(singContour(57, 2, () => 12, { sampleRate: 48000 }), 48000, 57, opts());
    expect(s.heldCents as number).toBeGreaterThan(7);
    expect(s.heldCents as number).toBeLessThan(17);
  });

  it('never invents a number for a quiet, silent, noisy or speech-like take', () => {
    const quiet = scoreHeldNote(singContour(57, 2.2, () => 0, { amplitude: 0.002 }), SR, 57, opts());
    expect(quiet.status).toBe('too-quiet');
    expect(quiet.heldCents).toBeNull();
    expect(quiet.findings[0].text).toMatch(/too quiet/);
    expect(scoreHeldNote(roomNoise(2), SR, 57, opts()).status).toBe('too-quiet');
    expect(scoreHeldNote(new Float32Array(SR), SR, 57, opts()).status).toBe('too-quiet');
    const noise = scoreHeldNote(inRoom(hiss(2, 0.05)), SR, 57, opts());
    expect(noise.status).toBe('no-pitch');
    expect(noise.heldCents).toBeNull();
    expect(scoreHeldNote(babble(3), SR, 57, opts()).status).not.toBe('ok');
  });
});

function fakeNote(heldCents: number | null, register: RegisterThird, extra: Partial<HeldNoteScore> = {}): HeldNoteScore {
  return {
    status: heldCents === null ? 'too-quiet' : 'ok',
    targetMidi: 57,
    sung: null,
    octaveOffset: 0,
    landingCents: heldCents,
    heldCents,
    stabilityCents: 6,
    timeToLandSec: 0.2,
    within: heldCents !== null && Math.abs(heldCents) <= 25,
    register,
    findings: [],
    ...extra,
  };
}

describe('scoreHeldNote: a different note is not an octave error', () => {
  it('a 5th, a tritone and 650 cents up are named as different notes, never "right note, one octave higher"', () => {
    for (const up of [700, 600, 650]) {
      const s = scoreHeldNote(singContour(57, 2.2, () => up), SR, 57, opts());
      expect(s.octaveOffset, `${up}`).toBe(0);
      expect(s.heldCents as number).toBeGreaterThan(up - 15);
      expect(s.heldCents as number).toBeLessThan(up + 15);
      expect(s.within).toBe(false);
      expect(s.findings.some((f) => /Right note/.test(f.text))).toBe(false);
      expect(s.findings[0].text).toMatch(/different note: about .* above/);
    }
    const fifth = scoreHeldNote(singContour(57, 2.2, () => 700), SR, 57, opts());
    expect(fifth.findings[0].text).toMatch(/about a perfect 5th above/);
  });

  it('an octave plus a small error is still "right note, one octave higher"', () => {
    const s = scoreHeldNote(singContour(57, 2.2, () => 1220), SR, 57, opts());
    expect(s.octaveOffset).toBe(1);
    expect(Math.abs((s.heldCents as number) - 20)).toBeLessThan(8);
  });

  it('time to land is found on a centred wide vibrato under Strict', () => {
    for (const rateHz of [4, 6, 7]) {
      const s = scoreHeldNote(singContour(57, 2.5, () => 0, { vibrato: { rateHz, extentCents: 100, delaySec: 0 } }), SR, 57, opts(baritone, 15));
      expect(Math.abs(s.heldCents as number), `${rateHz} Hz`).toBeLessThan(6);
      expect(s.timeToLandSec, `${rateHz} Hz`).not.toBeNull();
    }
  });
});

describe('summarisePitchTest', () => {
  it('keeps a different note out of the bias, the registers and the octave count', () => {
    const notes = [0, 2, -3, 1, 700, -2, 3, 0, 1, -1].map((c, i) => fakeNote(c, i < 3 ? 'low' : i < 7 ? 'mid' : 'high'));
    const s = summarisePitchTest(notes, 25);
    expect(s.wrongNotes).toBe(1);
    expect(s.octaveSlips).toBe(0);
    expect(Math.abs(s.biasCents as number)).toBeLessThan(2);
    expect(s.meanAbsCents as number).toBeLessThan(3);
    expect(s.byRegister.mid.n).toBe(3);
    expect(s.shareWithin).toBeCloseTo(0.9, 5);
    const text = s.findings.map((f) => f.text).join(' / ');
    expect(text).not.toMatch(/sit about|tend to sit/);
    expect(text).toMatch(/One note came out as a different note \(about a perfect 5th above/);
  });

  it('reports accuracy, bias and the weakest register in plain words', () => {
    const notes = [
      fakeNote(-5, 'low'),
      fakeNote(4, 'low'),
      fakeNote(-2, 'low'),
      fakeNote(8, 'mid'),
      fakeNote(-6, 'mid'),
      fakeNote(3, 'mid'),
      fakeNote(-10, 'mid'),
      fakeNote(-28, 'high'),
      fakeNote(-35, 'high', { octaveOffset: -1 }),
      fakeNote(null, 'high'),
    ];
    const s = summarisePitchTest(notes, 25);
    expect(s.scored).toBe(9);
    expect(s.unscored).toBe(1);
    expect(s.shareWithin).toBeCloseTo(7 / 9, 5);
    expect(s.shareWithin50).toBe(1);
    expect(s.meanAbsCents).toBeCloseTo(101 / 9, 5);
    expect(s.biasCents).toBeCloseTo(-71 / 9, 5);
    expect(s.octaveSlips).toBe(1);
    expect(s.byRegister.high.n).toBe(2);
    expect(s.byRegister.high.biasCents).toBeCloseTo(-31.5, 5);
    expect(s.findings.length).toBeLessThanOrEqual(3);
    expect(s.findings[0].text).toBe(`Your high notes sit about 32 cents flat (32 cents is about a third of a semitone).`);
    expect(s.findings.some((f) => /different octave/.test(f.text))).toBe(true);
  });

  it('praises a strong test and handles an empty one', () => {
    const good = summarisePitchTest([fakeNote(3, 'low'), fakeNote(-4, 'mid'), fakeNote(6, 'high'), fakeNote(-2, 'mid'), fakeNote(1, 'low')], 25);
    expect(good.findings[0].tone).toBe('good');
    expect(good.findings[0].text).toMatch(/100 % of your notes were within 25 cents/);
    const none = summarisePitchTest([fakeNote(null, 'low')], 25);
    expect(none.scored).toBe(0);
    expect(none.meanAbsCents).toBeNull();
    expect(none.findings[0].tone).toBe('info');
  });

  it('flags a general tendency to sit sharp', () => {
    const s = summarisePitchTest([12, 15, 18, 10, 14, 16].map((c, i) => fakeNote(c, (['low', 'mid', 'high'] as const)[i % 3])), 25);
    expect(s.findings.some((f) => f.text === 'Overall you tend to sit 14 cents sharp.')).toBe(true);
  });
});

describe('createLockTracker', () => {
  const reading = (t: number, cents: number | null): LiveReading => ({
    t,
    hz: cents === null ? null : 220,
    midi: cents === null ? null : 57 + cents / 100,
    rmsDb: -25,
    periodicity: 0.9,
  });

  it('locks after 1.5 s inside the band despite vibrato, and reports the time to find the note', () => {
    const lt = createLockTracker(57, 25);
    let last = null;
    for (let i = 0; i <= 150; i++) {
      const t = i * 0.025;
      // 0.5 s at +80 cents, then on the note with a 5.5 Hz +/-40 cent vibrato.
      const cents = t < 0.5 ? 80 : 40 * Math.sin(2 * Math.PI * 5.5 * t);
      last = lt.push(reading(t, cents));
      if (last.locked) break;
    }
    expect(last?.locked).toBe(true);
    expect(last?.lockSec as number).toBeGreaterThan(0.45);
    expect(last?.lockSec as number).toBeLessThan(0.75);
  });

  it('survives a short dropout but resets on a long one or on leaving the band', () => {
    const lt = createLockTracker(57, 25);
    for (let i = 0; i < 40; i++) lt.push(reading(i * 0.025, 5));
    const mid = lt.push(reading(1.0, null));
    expect(mid.heldSec).toBeGreaterThan(0.9);
    const gone = lt.push(reading(1.3, null));
    expect(gone.centsNow).toBeNull();
    expect(gone.heldSec).toBe(0);
    lt.reset();
    for (let i = 0; i < 20; i++) lt.push(reading(i * 0.025, 5));
    let out = lt.push(reading(0.5, 90));
    for (let i = 1; i <= 10; i++) out = lt.push(reading(0.5 + i * 0.025, 90));
    expect(out.inside).toBe(false);
    expect(out.heldSec).toBe(0);
    expect(out.locked).toBe(false);
  });

  it('locks in on a normal or wide vibrato that is centred or inside the band (whole cycles are averaged)', () => {
    const lockedWith = (tol: number, rateHz: number, extent: number, offset: number) => {
      const lt = createLockTracker(57, tol);
      let st = null;
      for (let i = 0; i <= 400; i++) {
        const t = i * 0.01;
        st = lt.push(reading(t, offset + extent * Math.sin(2 * Math.PI * rateHz * t)));
        if (st.locked) break;
      }
      return st?.locked ?? false;
    };
    for (const rate of [4, 5, 5.5, 6, 7]) {
      expect(lockedWith(15, rate, 100, 0), `strict, centred ±100 at ${rate} Hz`).toBe(true);
      expect(lockedWith(15, rate, 50, 5), `strict, ±50 5 cents sharp at ${rate} Hz`).toBe(true);
      expect(lockedWith(25, rate, 100, 10), `standard, ±100 10 cents sharp at ${rate} Hz`).toBe(true);
    }
    // Still honest: a vibrato centred 40 cents sharp never locks under Standard.
    expect(lockedWith(25, 5.5, 50, 40)).toBe(false);
  });

  it('judges pitch class (an octave below still counts)', () => {
    const lt = createLockTracker(57, 25, 0.5);
    let s = null;
    for (let i = 0; i < 30; i++) s = lt.push(reading(i * 0.025, -1200 + 4));
    expect(s?.locked).toBe(true);
    expect(Math.abs(s?.centsNow as number)).toBeLessThan(5);
  });
});

describe('formatting', () => {
  it('formats cents with a true minus and gives them meaning', () => {
    expect(MINUS).toBe(CHART_MINUS);
    expect(formatCents(12.4)).toBe('+12 cents');
    expect(formatCents(-8)).toBe(`${MINUS}8 cents`);
    expect(formatCents(0.3)).toBe('0 cents');
    expect(formatCents(1)).toBe('+1 cent');
    expect(formatCents(NaN)).toBe('–');
    expect(centsMeaning(25)).toBe('25 cents is a quarter of a semitone');
    expect(centsMeaning(-50)).toBe('50 cents is half a semitone');
    expect(centsMeaning(12)).toBe('12 cents is about a tenth of a semitone');
    expect(centsMeaning(100)).toBe('100 cents is a whole semitone');
    expect(centsMeaning(250)).toBe('250 cents is about 2.5 semitones');
    expect(centsMeaning(200)).toBe('200 cents is 2 semitones');
  });
});
