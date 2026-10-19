// Note accuracy on hard synthetic cases: wide vibrato on short line notes, the first note of a line, notes too short
// to measure, scoops, a sag at the end of a note, and the (switched-off) pure-tone voice check.
import { describe, expect, it } from 'vitest';
import { concat, mix, sine, synthMelody, synthVoice, type SynthOptions } from '../../testing/synth';
import { fitSequence, parseSequence } from '../theory';
import type { SequenceTarget } from '../types';
import { inRoom, roomNoise, singContour, singLine, SINGER, SR } from './fixtures';
import { scoreHeldNote, scoreLongTone, scoreSequence, scoreSungInterval, summarisePitchTest } from './index';
import { PURE_TONE_REFUSAL } from './constants';

const tenor = { lowMidi: 48, highMidi: 67 };
const opts = { a4Hz: 440, toleranceCents: 25 };
const held = (range = { lowMidi: 45, highMidi: 65 }) => ({ ...opts, range });
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function line(text: string, range = tenor): SequenceTarget {
  const p = parseSequence(text);
  if (!p.ok) throw new Error(p.error);
  const t = fitSequence(p.notes, 'major', range);
  if (!t) throw new Error('does not fit');
  return t;
}

function sing(t: SequenceTarget, durSec: number, vib: { rateHz: number; extentCents: number }, detached: boolean): Float32Array {
  const o: Omit<SynthOptions, 'f0' | 'durationSec'> = { ...SINGER, vibrato: { ...vib, delaySec: 0.1 } };
  const ns = t.midis.map((m) => ({ midi: m, durSec }));
  if (!detached) return inRoom(synthMelody(ns, o));
  const parts: Float32Array[] = [];
  ns.forEach((n, i) => {
    if (i) parts.push(new Float32Array(Math.round(0.15 * SR)));
    parts.push(synthMelody([n], { ...o, seed: 7 + i }));
  });
  return inRoom(concat(...parts));
}

describe('lines with a wide vibrato at the prompt pace (M3)', () => {
  const six = line('7 6 5 4 3 2');
  const eight = line('1 2 3 4 5 6 7 8');
  const cases: [SequenceTarget, number, number, number, boolean][] = [];
  for (const rate of [4.5, 6, 7]) for (const dur of [0.45, 0.6]) for (const det of [false, true]) cases.push([six, rate, 100, dur, det]);
  cases.push([six, 4.5, 100, 0.8, false], [six, 5.5, 50, 0.45, false], [eight, 5, 100, 0.45, false], [eight, 7, 100, 0.6, true]);

  it('in-tune notes of 0.45 s or longer read within 8 cents with +/-100 cent vibrato, with no extra notes and no drift', () => {
    for (const [t, rate, ext, dur, det] of cases) {
      const s = scoreSequence(sing(t, dur, { rateHz: rate, extentCents: ext }, det), SR, t, opts);
      const label = `${t.notes.length} notes, ${rate} Hz +/-${ext}, ${dur} s, ${det ? 'detached' : 'legato'}`;
      expect(s.status, label).toBe('ok');
      expect(s.missing, label).toBe(0);
      expect(s.extras, label).toHaveLength(0);
      const confident = s.notes.filter((n) => n.sung?.confidence !== 'low');
      // At most one note per take may be marked low confidence at this pace, and never on a 0.6 s note.
      expect(s.notes.length - confident.length, label).toBeLessThanOrEqual(dur >= 0.6 ? 0 : 1);
      for (const n of confident) expect(Math.abs(n.cents as number), `${label}, note ${n.index}`).toBeLessThanOrEqual(8);
      expect(Math.abs(s.driftCents as number), label).toBeLessThan(10);
      expect(s.findings.some((f) => /slid about/.test(f.text)), label).toBe(false);
      expect(s.noteAccuracy, label).toBe(1);
    }
  }, 60000);

  it('0.3 s notes with a +/-100 cent vibrato: any note read badly is marked low confidence and kept out of the figures', () => {
    for (const rate of [4.5, 7]) {
      const s = scoreSequence(sing(six, 0.3, { rateHz: rate, extentCents: 100 }, false), SR, six, opts);
      const low = s.notes.filter((n) => n.sung?.confidence === 'low');
      for (const n of s.notes) if (n.sung && n.sung.confidence !== 'low') expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
      expect(low.length).toBeGreaterThan(0);
      expect(s.findings.some((f) => /too short to measure reliably/.test(f.text))).toBe(true);
      expect(s.findings.some((f) => /slid about/.test(f.text))).toBe(false);
      // Nothing is named as out of tune on a note that could not be measured.
      for (const n of low) expect(s.findings.some((f) => f.text.startsWith(`Your ${n.written} sat`))).toBe(false);
    }
  }, 30000);
});

describe('rough notes are never hidden (N1)', () => {
  const six = line('7 6 5 4 3 2');
  const straight = (dur: number, cents: number[]) =>
    inRoom(synthMelody(six.midis.map((m, i) => ({ midi: m + (cents[i] ?? 0) / 100, durSec: dur })), { ...SINGER, vibrato: undefined }));

  it('a 0.3 s note sung a semitone off is named as a different note even though the note is rough', () => {
    for (const c of [-100, 100]) {
      const s = scoreSequence(straight(0.3, [0, 0, c]), SR, six, opts);
      const n = s.notes[2];
      expect(n.cents as number).toBeGreaterThan(c - 15);
      expect(n.cents as number).toBeLessThan(c + 15);
      expect(s.findings.map((f) => f.text).join(' / ')).not.toMatch(/Well pitched/);
      const dir = c < 0 ? 'flat' : 'sharp';
      expect(s.findings.some((f) => new RegExp(`Your 5 was clearly a different note \\(it read about (9\\d|1[01]\\d) cents ${dir}`).test(f.text))).toBe(true);
    }
  });

  it('a line with most notes rough gets no praise and no accuracy figure; a rough note that read clearly off is named', () => {
    const s = scoreSequence(straight(0.3, [-40]), SR, six, opts);
    const low = s.notes.filter((n) => n.sung?.confidence === 'low').length;
    expect(low).toBeGreaterThanOrEqual(3);
    const text = s.findings.map((f) => f.text).join(' / ');
    expect(text).not.toMatch(/Well pitched/);
    // Fewer than half the notes judged: no accuracy figure at all; otherwise the flat 7 keeps it under 100 %.
    if (low > 3) {
      expect(s.noteAccuracy).toBeNull();
      expect(text).toMatch(/not scored/);
    } else expect(s.noteAccuracy as number).toBeLessThan(1);
    if (s.notes[0].sung?.confidence === 'low') expect(text).toMatch(/Your 7 (sounded about [2-4]\d cents flat|sat)/);
    else expect(text).toMatch(/Your 7 sat/);
  });

  it('praise needs at least 80 % of the notes measured with confidence', () => {
    for (const dur of [0.3, 0.6]) {
      const s = scoreSequence(straight(dur, []), SR, six, opts);
      const counted = s.notes.filter((n) => n.sung && n.sung.confidence !== 'low').length;
      const praised = s.findings.some((f) => /Well pitched/.test(f.text));
      if (praised) expect(counted).toBeGreaterThanOrEqual(0.8 * six.notes.length);
      if (dur === 0.6) expect(praised).toBe(true);
    }
  });
});

describe('intervals (R1)', () => {
  it('an in-tune minor 2nd down with a tracker octave slip inside the second note is still a clean minor 2nd down', () => {
    // The verifier's take: 0.4 s of room noise either side (seed 11), the second note read an octave up for 0.37 s.
    const SRx = SR;
    for (const [a, b] of [[55, 54], [57, 56], [52, 51], [60, 59]]) for (const d of [0.9, 1]) {
      const x = synthMelody([{ midi: a, durSec: d }, { midi: b, durSec: d }], { ...SINGER, glideSec: 0.06 });
      const take = concat(new Float32Array(Math.round(0.4 * SRx)), x, new Float32Array(Math.round(0.4 * SRx)));
      const s = scoreSungInterval(mix(take, roomNoise(take.length / SRx, SRx, 11, 0.0008)), SRx, { referenceMidi: a, semitones: 1, direction: 'down' }, opts);
      expect(s.wrongDirection, `${a}->${b} ${d}s`).toBe(false);
      expect(Math.abs(s.intervalCents as number), `${a}->${b} ${d}s`).toBeLessThan(10);
      expect(s.within, `${a}->${b} ${d}s`).toBe(true);
    }
  });

  it('an interval with a rough note never also says "a clean ..."', () => {
    const t = { referenceMidi: 57, semitones: 5, direction: 'down' as const };
    const x = singLine([{ midi: 57, durSec: 0.2 }, { midi: 52, durSec: 1 }]);
    const s = scoreSungInterval(x, SR, t, opts);
    if (s.first?.confidence === 'low' || s.second?.confidence === 'low') {
      expect(s.within).toBe(false);
      expect(s.findings.some((f) => /A clean/.test(f.text))).toBe(false);
      expect(s.findings[0].text).toMatch(/rough/);
    }
  });
});

describe('the first note of a line (e2e-F3)', () => {
  it('a 40-cent-flat 7 reads -40 +/- 3 in four keys, sung in the octave asked and an octave low', () => {
    const p = parseSequence('7 6 5 4 3 2');
    if (!p.ok) throw new Error(p.error);
    for (const range of [{ lowMidi: 45, highMidi: 65 }, tenor, { lowMidi: 55, highMidi: 72 }, { lowMidi: 41, highMidi: 62 }]) {
      const t = fitSequence(p.notes, 'major', range) as SequenceTarget;
      for (const oct of [0, -12]) {
        const x = singLine(t.midis.map((m, i) => ({ midi: m + oct + (i === 0 ? -0.4 : 0), durSec: 0.6 })));
        const s = scoreSequence(x, SR, t, opts);
        expect(s.notes[0].cents as number).toBeGreaterThan(-43);
        expect(s.notes[0].cents as number).toBeLessThan(-37);
      }
    }
  }, 30000);
});

describe('notes too short to measure (L4)', () => {
  it('a 0.25 s held note is "too short", not "no steady sung note"', () => {
    const s = scoreHeldNote(singContour(57, 0.25, () => 0), SR, 57, held());
    expect(s.status).not.toBe('ok');
    expect(s.heldCents).toBeNull();
    expect(s.findings[0].text).toMatch(/too short to measure/);
    expect(s.findings[0].text).not.toMatch(/no steady sung note/);
  });

  it('a 0.4 s held note is shown as a rough reading and kept out of the pitch-test figures', () => {
    const s = scoreHeldNote(singContour(57, 0.4, () => 30), SR, 57, held());
    expect(s.status).toBe('ok');
    expect(s.sung?.confidence).toBe('low');
    expect(s.findings[0].text).toMatch(/reading is rough/);
    const long = scoreHeldNote(singContour(57, 1.5, () => 0), SR, 57, held());
    expect(long.sung?.confidence).toBe('high');
    const sum = summarisePitchTest([s, long], 25);
    expect(sum.scored).toBe(1);
    expect(sum.unscored).toBe(1);
    expect(Math.abs(sum.biasCents as number)).toBeLessThan(5);
    expect(sum.findings.some((f) => /too short to measure reliably/.test(f.text))).toBe(true);
    // A rough reading never claims "in tune", even when its number is inside the tolerance.
    const roughIn = scoreHeldNote(singContour(57, 0.35, () => 20), SR, 57, held());
    expect(roughIn.sung?.confidence).toBe('low');
    expect(roughIn.within).toBe(false);
    // A pitch test of only rough notes blames the note length, not the microphone.
    const allRough = summarisePitchTest([s, roughIn], 25);
    expect(allRough.scored).toBe(0);
    expect(allRough.findings[0].text).toMatch(/too short or too unsteady/);
    expect(allRough.findings[0].text).not.toMatch(/microphone/);
  });

  it('held notes of 0.45 s and longer are measured with confidence and read within 4 cents (W1)', () => {
    for (const d of [0.45, 0.5, 0.6]) for (const m of [45, 57, 64]) for (const off of [0, 30, -60]) {
      const s = scoreHeldNote(singContour(m, d, () => off), SR, m, held({ lowMidi: 40, highMidi: 70 }));
      expect(s.sung?.confidence, `${d} s at ${m}, ${off}`).toBe('high');
      expect(Math.abs((s.heldCents as number) - off), `${d} s at ${m}, ${off}`).toBeLessThan(4);
    }
  });

  it('a long note marked rough is not called "short" (L4)', () => {
    const s = scoreHeldNote(
      inRoom(synthVoice({ sampleRate: SR, durationSec: 2, f0: hz(79), breathNoise: 0.3, jitter: 0, amplitude: 0.01, vibrato: { rateHz: 5.5, extentCents: 40, delaySec: 0.15 }, vowel: 'u', tiltDbPerOct: -24, h1BoostDb: 12, seed: 1 })),
      SR,
      79,
      held({ lowMidi: 69, highMidi: 89 }),
    );
    for (const f of s.findings) expect(f.text).not.toMatch(/short|too short/);
  });
});

describe('scoops (M7)', () => {
  it('the landing and the "arrived under the note" finding grow with the depth and the length of the scoop', () => {
    const land = (depth: number, dur: number) => {
      const s = scoreHeldNote(singContour(57, 2.2, (t) => (t < dur ? -depth * (1 - t / dur) : 0)), SR, 57, held());
      expect(Math.abs(s.heldCents as number)).toBeLessThan(5);
      return s;
    };
    for (const dur of [0.2, 0.35]) {
      const a = land(100, dur);
      const b = land(200, dur);
      const c = land(300, dur);
      expect(b.landingCents as number).toBeLessThan((a.landingCents as number) - 20);
      expect(c.landingCents as number).toBeLessThan((b.landingCents as number) - 20);
      for (const s of [a, b, c]) expect(s.findings.some((f) => /cents under the note and then slid up/.test(f.text))).toBe(true);
    }
    expect(land(300, 0.35).landingCents as number).toBeLessThan(-150);
    expect(land(200, 0.35).landingCents as number).toBeLessThan(land(200, 0.2).landingCents as number);
  });

  it('slow scoops into each note of a line (150-300 cents over 150-300 ms) are not extra notes', () => {
    const t = line('1 3 5 3 1');
    for (const [depth, sc] of [[150, 0.15], [200, 0.25], [300, 0.25], [300, 0.3]]) {
      const dur = 0.6;
      const f0 = (tt: number) => {
        const i = Math.min(t.midis.length - 1, Math.floor(tt / dur));
        const into = tt - i * dur;
        return hz(t.midis[i] + (into < sc ? -depth * (1 - into / sc) : 0) / 100);
      };
      const s = scoreSequence(inRoom(synthVoice({ ...SINGER, f0, durationSec: dur * t.midis.length })), SR, t, opts);
      const label = `scoop -${depth} over ${sc} s`;
      expect(s.extras, label).toHaveLength(0);
      expect(s.missing, label).toBe(0);
      for (const n of s.notes) expect(Math.abs(n.cents as number), label).toBeLessThanOrEqual(8);
    }
  }, 30000);
});

describe('a sag at the end of a note (L2)', () => {
  const sag = (len: number, sagSec: number, cents: number) => (t: number) => (t > len - sagSec ? (cents * (t - (len - sagSec))) / sagSec : 0);

  it('a held note that sags 30 cents over its last second is reported; a steady one is not', () => {
    // The measure is the last 0.5 s of the steady part against the rest: a linear sag to -30 at the release reads
    // about -14 there (its mean over that window).
    const s = scoreHeldNote(singContour(57, 2.4, sag(2.4, 1, -30)), SR, 57, held());
    expect(s.endDriftCents as number).toBeLessThan(-10);
    expect(s.endDriftCents as number).toBeGreaterThan(-25);
    expect(s.findings.some((f) => /sagged about \d+ cents flat/.test(f.text))).toBe(true);
    const steady = scoreHeldNote(singContour(57, 2.4, () => 0), SR, 57, held());
    expect(Math.abs(steady.endDriftCents as number)).toBeLessThan(8);
    expect(steady.findings.some((f) => /sagged|crept/.test(f.text))).toBe(false);
  });

  it('a long tone that sags 30 cents over its last second is not called very steady without saying so', () => {
    const s = scoreLongTone(singContour(57, 8, sag(8, 1, -30)), SR, { a4Hz: 440 });
    expect(s.status).toBe('ok');
    expect(s.endDriftCents as number).toBeLessThan(-12);
    expect(s.endDriftCents as number).toBeGreaterThan(-28);
    expect(s.findings.some((f) => /sagged about \d+ cents flat/.test(f.text))).toBe(true);
    expect(s.findings[0].tone).toBe('work');
    expect(s.findings[0].text).toMatch(/until the last second/);
    const steady = scoreLongTone(singContour(57, 8, () => 0), SR, { a4Hz: 440 });
    expect(Math.abs(steady.endDriftCents as number)).toBeLessThan(8);
    expect(steady.findings.some((f) => /sagged|crept/.test(f.text))).toBe(false);
  });
});

describe('voice check (L5)', () => {
  it('is switched off: a steady pure tone is scored like a note (known limit, see PURE_TONE_REFUSAL)', () => {
    expect(PURE_TONE_REFUSAL).toBe(false);
    const s = scoreHeldNote(inRoom(sine(hz(57), 2, SR, 0.3)), SR, 57, held({ lowMidi: 40, highMidi: 72 }));
    expect(s.status).toBe('ok');
    expect(s.findings.some((f) => /pure electronic tone/.test(f.text))).toBe(false);
    const t = line('5 4 3 2 1');
    const tones = inRoom(concat(...t.midis.map((m) => sine(hz(m), 0.6, SR, 0.2))));
    expect(scoreSequence(tones, SR, t, opts).status).toBe('ok');
  });

  it('never refuses a real-sounding voice: breath noise 0 to 1, soft, falsetto-like, high and low', () => {
    const voices: [string, number, Partial<SynthOptions>][] = [];
    for (const bn of [0, 0.3, 0.6, 1]) for (const m of [45, 57, 72]) voices.push([`breath ${bn}`, m, { breathNoise: bn }]);
    for (const [amp, bn] of [[0.02, 0], [0.01, 0], [0.02, 0.6]]) voices.push([`soft ${amp} breath ${bn}`, 57, { amplitude: amp, breathNoise: bn }]);
    for (const v of ['a', 'u', 'i'] as const) for (const m of [64, 72, 79]) for (const bn of [0, 0.8]) {
      voices.push([`falsetto ${v} breath ${bn}`, m, { vowel: v, tiltDbPerOct: -20, h1BoostDb: 8, breathNoise: bn }]);
    }
    voices.push(['no vibrato, no breath', 57, { vibrato: undefined, breathNoise: 0 }]);
    for (const [label, m, o] of voices) {
      const s = scoreHeldNote(inRoom(synthVoice({ ...SINGER, ...o, durationSec: 2, f0: hz(m) })), SR, m, held({ lowMidi: 40, highMidi: 81 }));
      expect(s.status, `${label} at ${m}`).toBe('ok');
      expect(Math.abs(s.heldCents as number), `${label} at ${m}`).toBeLessThan(8);
    }
  }, 60000);
});
