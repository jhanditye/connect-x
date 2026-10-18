import { describe, expect, it } from 'vitest';
import { concat } from '../../testing/synth';
import { fitSequence, parseSequence } from '../theory';
import type { SequenceTarget, SungNote } from '../types';
import { alignNotes, scoreSequence, scoreSungInterval, segmentNotes } from './index';
import { theilSenSlope } from './line';
import { hiss, roomNoise, singDetached, singLine, SR } from './fixtures';

const opts = { a4Hz: 440, toleranceCents: 25 };
const tenor = { lowMidi: 48, highMidi: 67 };
const soprano = { lowMidi: 57, highMidi: 74 };

function target(text: string, range = tenor): SequenceTarget {
  const p = parseSequence(text);
  if (!p.ok) throw new Error(p.error);
  const t = fitSequence(p.notes, 'major', range);
  if (!t) throw new Error('does not fit');
  return t;
}

/** The target's notes, each `durSec`, with per-note detune in cents. */
const notesOf = (t: SequenceTarget, cents: number[] = [], durSec = 0.5) => t.midis.map((m, i) => ({ midi: m + (cents[i] ?? 0) / 100, durSec }));

describe('scoreSequence: "7 6 5 4 3 2" on the synthetic singer', () => {
  const t = target('7 6 5 4 3 2');

  it('scores an in-tune line within a few cents per note', () => {
    const s = scoreSequence(singLine(notesOf(t)), SR, t, opts);
    expect(s.status).toBe('ok');
    expect(s.missing).toBe(0);
    expect(s.extras).toHaveLength(0);
    expect(s.octaveOffset).toBe(0);
    expect(s.noteAccuracy).toBe(1);
    for (const n of s.notes) expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
    expect(Math.abs(s.driftCents as number)).toBeLessThan(10);
    expect(s.findings[0].tone).toBe('good');
  });

  it('finds the flat 7 on the right note and nowhere else (and does not call it drift)', () => {
    const s = scoreSequence(singLine(notesOf(t, [-40])), SR, t, opts);
    expect(s.notes[0].cents as number).toBeGreaterThan(-48);
    expect(s.notes[0].cents as number).toBeLessThan(-32);
    expect(s.notes[0].within).toBe(false);
    for (const n of s.notes.slice(1)) expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
    // The step from the flat 7 down to an in-tune 6 is 40 cents smaller than asked: signed step error +40.
    expect(s.notes[1].intervalCents as number).toBeGreaterThan(32);
    expect(s.findings.some((f) => /^Your 7 sat 4\d cents flat/.test(f.text))).toBe(true);
    expect(s.findings.some((f) => /slid/.test(f.text))).toBe(false);
  });

  it('aligns a missing note (the 5 left out)', () => {
    const s = scoreSequence(singLine(notesOf(t).filter((_, i) => i !== 2)), SR, t, opts);
    expect(s.missing).toBe(1);
    expect(s.notes[2].sung).toBeNull();
    expect(s.notes[2].cents).toBeNull();
    expect(s.extras).toHaveLength(0);
    for (const i of [0, 1, 3, 4, 5]) expect(Math.abs(s.notes[i].cents as number)).toBeLessThanOrEqual(8);
    expect(s.noteAccuracy).toBeCloseTo(5 / 6, 5);
  });

  it('aligns an extra short note and keeps the rest matched', () => {
    const notes = notesOf(t);
    const withExtra = [...notes.slice(0, 3), { midi: t.midis[2] + 3, durSec: 0.15 }, ...notes.slice(3)];
    const s = scoreSequence(singLine(withExtra), SR, t, opts);
    expect(s.extras).toHaveLength(1);
    expect(s.extras[0].midi).toBeCloseTo(t.midis[2] + 3, 0);
    expect(s.missing).toBe(0);
    for (const n of s.notes) expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
  });

  it('does not count 80 ms legato glides as notes', () => {
    const x = singLine(notesOf(t), { glideSec: 0.08 });
    expect(segmentNotes(x, SR, 440)).toHaveLength(6);
    const s = scoreSequence(x, SR, t, opts);
    expect(s.extras).toHaveLength(0);
    expect(s.noteAccuracy).toBe(1);
  });

  it('accepts the whole line an octave lower and says so', () => {
    const s = scoreSequence(singLine(notesOf(t).map((n) => ({ ...n, midi: n.midi - 12 }))), SR, t, opts);
    expect(s.octaveOffset).toBe(-1);
    expect(s.noteAccuracy).toBe(1);
    for (const n of s.notes) {
      expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
      expect(n.octaveSlip).toBe(false);
    }
    expect(s.findings.some((f) => /an octave lower. That is fine/.test(f.text))).toBe(true);
  });

  it('folds and flags a single note that jumps an octave', () => {
    const notes = notesOf(t);
    notes[3] = { ...notes[3], midi: notes[3].midi - 12 };
    const s = scoreSequence(singLine(notes), SR, t, opts);
    expect(s.octaveOffset).toBe(0);
    expect(s.notes[3].octaveSlip).toBe(true);
    expect(Math.abs(s.notes[3].cents as number)).toBeLessThanOrEqual(8);
    expect(s.missing).toBe(0);
  });

  it('measures a linear -40 cent slide over the line as drift', () => {
    const s = scoreSequence(singLine(notesOf(t, [0, -8, -16, -24, -32, -40])), SR, t, opts);
    expect(s.driftCents as number).toBeGreaterThan(-48);
    expect(s.driftCents as number).toBeLessThan(-32);
    expect(s.findings.some((f) => /slid about \d+ cents flat/.test(f.text))).toBe(true);
  });

  it('scores detached notes, breath noise between notes and a 48 kHz take', () => {
    const det = scoreSequence(singDetached(notesOf(t), 0.2), SR, t, opts);
    expect(det.noteAccuracy).toBe(1);
    expect(det.extras).toHaveLength(0);
    // Audible breaths (hiss bursts) between detached notes are not notes.
    const parts = notesOf(t).map((n, i) => concat(singLine([n]), i < 5 ? hiss(0.25, 0.01, SR, 60 + i) : new Float32Array(0)));
    const breathy = scoreSequence(concat(...parts), SR, t, opts);
    expect(breathy.extras).toHaveLength(0);
    expect(breathy.noteAccuracy).toBe(1);
    const hi = scoreSequence(singLine(notesOf(t), { sampleRate: 48000 }), 48000, t, opts);
    expect(hi.noteAccuracy).toBe(1);
  });
});

describe('scoreSequence: other lines and voices', () => {
  it('"2 7 6 5" with the 7 below, in a soprano range, with a sharp 2', () => {
    const t = target('2 7 6 5', soprano);
    expect(t.midis[1]).toBeLessThan(t.midis[0]);
    const s = scoreSequence(singLine(notesOf(t, [30]), { tiltDbPerOct: -15 }), SR, t, opts);
    expect(s.notes[0].cents as number).toBeGreaterThan(22);
    expect(s.notes[0].cents as number).toBeLessThan(38);
    for (const n of s.notes.slice(1)) expect(Math.abs(n.cents as number)).toBeLessThanOrEqual(8);
  });

  it('separates repeated notes ("1 1 5 5") when they are re-sung', () => {
    const t = target('1 1 5 5');
    const s = scoreSequence(singDetached(notesOf(t, [], 0.45), 0.12), SR, t, opts);
    expect(s.missing).toBe(0);
    expect(s.noteAccuracy).toBe(1);
  });

  it('reports too-quiet and no-pitch instead of numbers', () => {
    const t = target('1 3 5 8 5 3 1');
    const quiet = scoreSequence(singLine(notesOf(t), { amplitude: 0.002 }), SR, t, opts);
    expect(quiet.status).toBe('too-quiet');
    expect(quiet.noteAccuracy).toBeNull();
    expect(quiet.missing).toBe(7);
    expect(scoreSequence(roomNoise(3), SR, t, opts).status).toBe('too-quiet');
    expect(scoreSequence(concat(roomNoise(0.5), hiss(3, 0.05)), SR, t, opts).status).toBe('no-pitch');
  });
});

describe('alignNotes', () => {
  const note = (midi: number, startSec: number, dur = 0.4): SungNote => ({
    startSec,
    endSec: startSec + dur,
    midi,
    landingMidi: null,
    stabilityCents: 5,
    steadySec: dur,
    meanRmsDb: -20,
  });

  it('matches in order with missing and extra notes', () => {
    const exp = [62, 60, 58, 56];
    expect(alignNotes(exp, [note(62, 0), note(60, 0.5), note(58, 1), note(56, 1.5)], 0)).toEqual({ match: [0, 1, 2, 3], extras: [] });
    expect(alignNotes(exp, [note(62, 0), note(58, 1), note(56, 1.5)], 0)).toEqual({ match: [0, null, 1, 2], extras: [] });
    expect(alignNotes(exp, [note(62, 0), note(65, 0.4, 0.1), note(60, 0.5), note(58, 1), note(56, 1.5)], 0)).toEqual({
      match: [0, 2, 3, 4],
      extras: [1],
    });
    expect(alignNotes(exp, [], 0)).toEqual({ match: [null, null, null, null], extras: [] });
  });

  it('uses the octave offset it is given', () => {
    const sung = [note(50, 0), note(48, 0.5), note(46, 1), note(44, 1.5)];
    expect(alignNotes([62, 60, 58, 56], sung, -1).match).toEqual([0, 1, 2, 3]);
  });

  it('Theil-Sen drift ignores one outlier', () => {
    expect(theilSenSlope([0, 1, 2, 3, 4, 5], [-40, 0, 0, 0, 0, 0])).toBe(0);
    expect(theilSenSlope([0, 1, 2, 3], [0, -10, -20, -30])).toBeCloseTo(-10, 9);
  });
});

describe('scoreSungInterval', () => {
  it('separates the interval size from the starting pitch: 30 cents wide from a 20-cent-sharp start', () => {
    const tgt = { referenceMidi: 52, semitones: 9, direction: 'up' as const };
    const s = scoreSungInterval(singLine([{ midi: 52.2, durSec: 1 }, { midi: 52.2 + 9.3, durSec: 1 }]), SR, tgt, opts);
    expect(s.status).toBe('ok');
    expect(s.referenceCents as number).toBeGreaterThan(15);
    expect(s.referenceCents as number).toBeLessThan(25);
    expect(s.intervalCents as number).toBeGreaterThan(25);
    expect(s.intervalCents as number).toBeLessThan(35);
    expect(s.targetCents as number).toBeGreaterThan(42);
    expect(s.targetCents as number).toBeLessThan(58);
    expect(s.sungSemitones as number).toBeCloseTo(9.3, 1);
    expect(s.within).toBe(false);
    expect(s.wrongDirection).toBe(false);
    expect(s.findings[0].text).toMatch(/^Your major 6th was \d+ cents too wide/);
  });

  it('scores a clean interval down, sung an octave low, as within', () => {
    const tgt = { referenceMidi: 64, semitones: 5, direction: 'down' as const };
    const s = scoreSungInterval(singDetached([{ midi: 52, durSec: 0.9 }, { midi: 47, durSec: 0.9 }], 0.2), SR, tgt, opts);
    expect(s.octaveOffset).toBe(-1);
    expect(Math.abs(s.intervalCents as number)).toBeLessThan(8);
    expect(s.within).toBe(true);
    expect(s.findings[0].tone).toBe('good');
  });

  it('flags the wrong direction (a minor 3rd down instead of a major 6th up lands on the same note name)', () => {
    const tgt = { referenceMidi: 55, semitones: 9, direction: 'up' as const };
    const s = scoreSungInterval(singLine([{ midi: 55, durSec: 1 }, { midi: 52, durSec: 1 }]), SR, tgt, opts);
    expect(s.wrongDirection).toBe(true);
    expect(s.within).toBe(false);
    expect(Math.abs(s.intervalCents as number)).toBeLessThanOrEqual(600);
    expect(s.findings[0].text).toMatch(/went down instead of up/);
  });

  it('says so when only one note was heard, and when nothing was', () => {
    const tgt = { referenceMidi: 55, semitones: 7, direction: 'up' as const };
    const one = scoreSungInterval(singLine([{ midi: 55, durSec: 1.5 }]), SR, tgt, opts);
    expect(one.first).not.toBeNull();
    expect(one.second).toBeNull();
    expect(one.intervalCents).toBeNull();
    expect(one.within).toBe(false);
    expect(scoreSungInterval(roomNoise(2), SR, tgt, opts).status).toBe('too-quiet');
  });
});
