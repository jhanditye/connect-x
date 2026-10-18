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

describe('scoreSequence: wrong notes, wrong leaps and wrong keys are not "well pitched"', () => {
  const rel = (t: SequenceTarget, semis: number[]) => semis.map((x) => ({ midi: t.key.tonicMidi + x, durSec: 0.6 }));
  const texts = (s: { findings: { text: string }[] }) => s.findings.map((f) => f.text).join(' / ');

  it('"2 7 6 5" with a 6th UP to the 7 is caught as a wrong leap, not praised', () => {
    const t = target('2 7 6 5');
    const s = scoreSequence(singLine(rel(t, [2, 11, 9, 7])), SR, t, opts);
    expect(s.noteAccuracy as number).toBeLessThan(1);
    expect(texts(s)).not.toMatch(/Well pitched/);
    expect(texts(s)).toMatch(/From 2 to 7 you sang a major 6th up; it should be a minor 3rd down/);
  });

  it('"1 3 5 8 5 3 1" with no octave leap is not praised', () => {
    const t = target('1 3 5 8 5 3 1');
    const s = scoreSequence(singLine(rel(t, [0, 4, 7, 0, 7, 4, 0])), SR, t, opts);
    expect(texts(s)).not.toMatch(/Well pitched/);
    expect(s.notes.filter((n) => n.within).length).toBeLessThan(7);
    expect(texts(s)).toMatch(/you sang a perfect 4th down; it should be a perfect 4th up|jumped to a different octave/);
  });

  it('a 3 sung as a 4 is named, kept out of the tuning figures and stops the praise', () => {
    const t = target('7 6 5 4 3 2');
    const s = scoreSequence(singDetached(rel(t, [11, 9, 7, 5, 5, 2])), SR, t, opts);
    expect(texts(s)).not.toMatch(/Well pitched/);
    expect(texts(s)).toMatch(/You sang a 4 where the 3 was written \(a semitone sharp\)/);
    expect(Math.abs(s.biasCents as number)).toBeLessThan(8);
  });

  it('the right shape 2 semitones above the key is said so, without blaming one degree', () => {
    const t = target('7 6 5 4 3 2');
    const s = scoreSequence(singLine(notesOf(t, [200, 200, 200, 200, 200, 200], 0.6)), SR, t, opts);
    expect(s.missing).toBe(0);
    expect(s.keyShiftCents as number).toBeGreaterThan(180);
    expect(texts(s)).toMatch(/^Right shape, but the whole line sat about 2 semitones above the key/);
    expect(texts(s)).not.toMatch(/Your \d sat/);
  });

  it('a line 50 cents flat throughout is one finding about the key, not "your 1 sat 50 cents flat"', () => {
    const t = target('5 4 3 2 1');
    const s = scoreSequence(singLine(notesOf(t, [-50, -50, -50, -50, -50], 0.6)), SR, t, opts);
    expect(s.keyShiftCents as number).toBeLessThan(-40);
    expect(texts(s)).toMatch(/about \d+ cents below the key/);
    expect(texts(s)).not.toMatch(/Your 1 sat/);
  });

  it('one flat last note on a 4-note line is not reported as the line sliding', () => {
    const t = target('5 4 3 2');
    const s = scoreSequence(singLine(notesOf(t, [0, 0, 0, -40], 0.6)), SR, t, opts);
    expect(texts(s)).not.toMatch(/slid/);
    expect(texts(s)).toMatch(/Your 2 sat \d+ cents flat/);
  });

  it('a repeated note sung legato as one long note gets advice, not "a note I could not hear"', () => {
    const t = target('5 5 4 3');
    const s = scoreSequence(singLine([{ midi: t.midis[0], durSec: 1.2 }, { midi: t.midis[2], durSec: 0.6 }, { midi: t.midis[3], durSec: 0.6 }]), SR, t, opts);
    expect(texts(s)).toMatch(/one long note where the same note was written twice/);
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
    // The real size error, never folded to the same note name: down 3 instead of up 9 is 12 semitones off.
    expect(s.intervalCents as number).toBeGreaterThan(-1215);
    expect(s.intervalCents as number).toBeLessThan(-1185);
    expect(s.findings[0].text).toMatch(/went down instead of up: you sang a minor 3rd down; the target was a major 6th up/);
  });

  const sing2 = (a: number, b: number, dur = 1) => singLine([{ midi: a, durSec: dur }, { midi: b, durSec: dur }]);

  it('names a clearly wrong interval instead of saying the second note was not heard', () => {
    const cases: [number, number, RegExp][] = [
      [9, 3, /^You sang a minor 3rd up; the target was a major 6th up/],
      [12, 4, /^You sang a major 3rd up; the target was an octave up/],
      [10, 3, /^You sang a minor 3rd up; the target was a minor 7th up/],
      [11, 5, /^You sang a perfect 4th up; the target was a major 7th up/],
      [9, 2, /^You sang a major 2nd up; the target was a major 6th up/],
      [11, 2, /^You sang a major 2nd up; the target was a major 7th up/],
      [12, 7, /^You sang a perfect 5th up; the target was an octave up/],
    ];
    for (const [asked, sang, re] of cases) {
      const s = scoreSungInterval(sing2(50, 50 + sang), SR, { referenceMidi: 50, semitones: asked, direction: 'up' }, opts);
      expect(s.second, `asked ${asked} sang ${sang}`).not.toBeNull();
      expect(s.within).toBe(false);
      expect(Math.abs((s.intervalCents as number) - (sang - asked) * 100)).toBeLessThan(15);
      expect(s.findings[0].text).toMatch(re);
      expect(s.findings.some((f) => /another octave/.test(f.text))).toBe(false);
    }
    const down = scoreSungInterval(sing2(62, 57), SR, { referenceMidi: 62, semitones: 12, direction: 'down' }, opts);
    expect(down.findings[0].text).toMatch(/^You sang a perfect 4th down; the target was an octave down/);
  });

  it('an octave jump that stays on the same note is about 1200 cents off and never "the right size"', () => {
    const s = scoreSungInterval(singDetached([{ midi: 50, durSec: 1 }, { midi: 50, durSec: 1 }], 0.2), SR, { referenceMidi: 50, semitones: 12, direction: 'up' }, opts);
    expect(s.within).toBe(false);
    expect(s.intervalCents as number).toBeLessThan(-1150);
    expect(s.findings[0].text).toMatch(/right name but was in another octave: you sang the same note; the target was an octave up/);
    const six = scoreSungInterval(sing2(50, 47, 1), SR, { referenceMidi: 50, semitones: 9, direction: 'up' }, opts);
    expect(six.within).toBe(false);
    expect(six.intervalCents as number).toBeLessThan(-1150);
  });

  it('a semitone sung 40-50 cents narrow and legato still gives an interval and a true first note', () => {
    for (const sungCents of [50, 60]) {
      const s = scoreSungInterval(sing2(55, 55 + sungCents / 100), SR, { referenceMidi: 55, semitones: 1, direction: 'up' }, opts);
      expect(s.intervalCents, `sung ${sungCents}`).not.toBeNull();
      expect(Math.abs((s.intervalCents as number) - (sungCents - 100))).toBeLessThan(12);
      expect(Math.abs(s.referenceCents as number)).toBeLessThan(10);
    }
  });

  it('a unison sung legato (no break) is two notes, in tune', () => {
    const s = scoreSungInterval(singLine([{ midi: 55, durSec: 2 }]), SR, { referenceMidi: 55, semitones: 0, direction: 'up' }, opts);
    expect(s.second).not.toBeNull();
    expect(s.within).toBe(true);
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
