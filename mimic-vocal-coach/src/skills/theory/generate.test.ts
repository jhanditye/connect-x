import { describe, expect, it } from 'vitest';
import type { Degree } from '../types';
import { degreeQuestion, intervalQuestion, intervalTargetOf, lineFromDegrees, mixedLength, randomLine, registerCounts, singIntervalTarget, singleNoteTargets, stepwise } from './generate';
import { earSetForLevel } from './intervals';
import { comfortableRange, registerThirdOf } from './range';
import { mulberry32, randInt, shuffle, weightedIndex } from './rng';
import { SCALE_STEPS } from './scales';

const range = comfortableRange('baritone'); // 45..65

describe('seeded rng', () => {
  it('same seed, same stream; different seeds differ', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const xa = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xa);
    expect(c()).not.toBe(xa[0]);
    for (const x of xa) expect(x >= 0 && x < 1).toBe(true);
  });

  it('helpers stay in bounds', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      const v = randInt(rng, 3, 5);
      expect(v >= 3 && v <= 5).toBe(true);
    }
    expect(shuffle(rng, [1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
    expect(weightedIndex(rng, [])).toBe(-1);
    // Zero weights are never picked when another weight is positive.
    for (let i = 0; i < 100; i++) expect(weightedIndex(rng, [0, 0, 1, 0])).toBe(2);
  });

  it('weights bias the choice in proportion', () => {
    const rng = mulberry32(9);
    const counts = [0, 0];
    for (let i = 0; i < 4000; i++) counts[weightedIndex(rng, [1, 3])]++;
    expect(counts[1] / 4000).toBeGreaterThan(0.7);
    expect(counts[1] / 4000).toBeLessThan(0.8);
  });
});

describe('single-note targets', () => {
  it('10 notes: 3 low, 4 mid, 3 high, all inside the range, no back-to-back repeats, deterministic', () => {
    expect(registerCounts(10)).toEqual({ low: 3, mid: 4, high: 3 });
    const a = singleNoteTargets(range, 10, mulberry32(7));
    const b = singleNoteTargets(range, 10, mulberry32(7));
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    const byReg = { low: 0, mid: 0, high: 0 };
    a.forEach((n, i) => {
      expect(n.midi >= range.lowMidi && n.midi <= range.highMidi).toBe(true);
      expect(registerThirdOf(n.midi, range)).toBe(n.register);
      byReg[n.register]++;
      if (i > 0) expect(n.midi).not.toBe(a[i - 1].midi);
    });
    expect(byReg).toEqual({ low: 3, mid: 4, high: 3 });
  });
});

describe('interval questions and drills', () => {
  it('ear questions use only the set, both notes inside the range', () => {
    const rng = mulberry32(3);
    const set = earSetForLevel(1);
    for (let i = 0; i < 200; i++) {
      const q = intervalQuestion(rng, set, range, { directions: ['up', 'down', 'harmonic'] });
      expect(q.kind).toBe('interval');
      if (q.kind !== 'interval') continue;
      expect(set).toContain(q.semitones);
      expect(q.choices).toEqual(set);
      const second = q.direction === 'down' ? q.firstMidi - q.semitones : q.firstMidi + q.semitones;
      for (const m of [q.firstMidi, second]) expect(m >= range.lowMidi && m <= range.highMidi).toBe(true);
    }
  });

  it('weights steer ear questions to weak intervals', () => {
    const rng = mulberry32(4);
    const set = earSetForLevel(1); // [4, 5, 7, 12]
    let weak = 0;
    for (let i = 0; i < 500; i++) {
      const q = intervalQuestion(rng, set, range, { weights: [0.1, 0.1, 0.1, 2] });
      if (q.kind === 'interval' && q.semitones === 12) weak++;
    }
    expect(weak / 500).toBeGreaterThan(0.8);
  });

  it('sung-interval targets stay inside the range in both directions', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const t = singIntervalTarget(rng, earSetForLevel(5), range);
      const second = intervalTargetOf(t);
      expect(t.semitones).toBeGreaterThan(0);
      for (const m of [t.referenceMidi, second]) expect(m >= range.lowMidi && m <= range.highMidi).toBe(true);
    }
  });

  it('degree questions: the note is that degree of the key and inside the range', () => {
    const rng = mulberry32(6);
    for (let i = 0; i < 100; i++) {
      const q = degreeQuestion(rng, 'harmonic-minor', range);
      if (q.kind !== 'degree') throw new Error('kind');
      expect(q.midi - q.key.tonicMidi).toBe(SCALE_STEPS['harmonic-minor'][q.degree - 1]);
      expect(q.midi >= range.lowMidi && q.midi <= range.highMidi).toBe(true);
      expect(q.key.tonicMidi >= range.lowMidi).toBe(true);
      expect(q.choices).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });
});

describe('lines', () => {
  it('stepwise runs', () => {
    expect(stepwise(7, 2)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(stepwise(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(lineFromDegrees(stepwise(8, 1), 'major').map((n) => n.semitones)).toEqual([12, 11, 9, 7, 5, 4, 2, 0]);
  });

  it('random lines follow the rules (start on 1/3/5, no repeats, leap <= a 5th, span <= an octave)', () => {
    const rng = mulberry32(21);
    for (let i = 0; i < 300; i++) {
      const n = mixedLength(rng);
      expect(n >= 4 && n <= 8).toBe(true);
      const line = randomLine(rng, n, 'major');
      expect(line).toHaveLength(n);
      expect([1, 3, 5]).toContain(line[0].degree);
      for (let k = 1; k < line.length; k++) {
        expect(line[k].degree).not.toBe(line[k - 1].degree);
        expect(Math.abs(line[k].semitones - line[k - 1].semitones)).toBeLessThanOrEqual(7);
      }
      const s = line.map((x) => x.semitones);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(12);
    }
  });

  it('degree weights bias random lines toward weak degrees', () => {
    const rng = mulberry32(22);
    const counts: Record<Degree, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
    let total = 0;
    for (let i = 0; i < 300; i++) {
      for (const n of randomLine(rng, 6, 'major', { degreeWeights: [1, 1, 1, 1, 1, 1, 6] }).slice(1)) {
        counts[n.degree]++;
        total++;
      }
    }
    // Without weights 7 would be about 1/6 of the non-first notes.
    expect(counts[7] / total).toBeGreaterThan(0.3);
  });

  it('random lines are deterministic for a seed', () => {
    expect(randomLine(mulberry32(8), 6, 'natural-minor')).toEqual(randomLine(mulberry32(8), 6, 'natural-minor'));
  });
});

describe('randomLine leaves out tritone leaps (until asked for)', () => {
  it('no step of 6 semitones over many seeds, and some 5ths do appear', () => {
    let fifths = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const notes = randomLine(mulberry32(seed), 6, 'major');
      for (let i = 1; i < notes.length; i++) {
        const st = Math.abs(notes[i].semitones - notes[i - 1].semitones);
        expect(st).not.toBe(6);
        if (st === 7) fifths++;
      }
    }
    expect(fifths).toBeGreaterThan(0);
  });
});
