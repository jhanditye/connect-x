import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../theory/rng';
import type { SkillsSession } from '../types';
import { emptySkillsStore, recordSkillsSession } from './store';
import {
  applySessionToStats,
  degreeWeights,
  intervalSetWeakness,
  intervalWeakness,
  rebuildStats,
  updateCents,
  updateRate,
  weakestIntervals,
} from './stats';
import { emptySkillsStats } from './parse';
import { breathSession, degreeEarSession, earSession, matchSession, pitchTestSession, sequenceSession, singSession } from './testKit';

const T = '2026-10-01T09:00:00.000Z';

describe('moving averages', () => {
  it('is a running mean for the first five values, then weights each new value 20 %', () => {
    let s = updateCents(undefined, 10, T);
    expect(s).toEqual({ n: 1, emaSigned: 10, emaAbs: 10, lastAt: T });
    s = updateCents(s, -30, T);
    expect(s.emaSigned).toBeCloseTo(-10, 10);
    expect(s.emaAbs).toBeCloseTo(20, 10);
    s = updateCents(s, 20, T);
    s = updateCents(s, 0, T);
    s = updateCents(s, 0, T);
    // Mean of 10, -30, 20, 0, 0 = 0; of the absolutes = 12.
    expect(s.n).toBe(5);
    expect(s.emaSigned).toBeCloseTo(0, 10);
    expect(s.emaAbs).toBeCloseTo(12, 10);
    s = updateCents(s, 50, T);
    expect(s.emaSigned).toBeCloseTo(0.8 * 0 + 0.2 * 50, 10);
    expect(s.emaAbs).toBeCloseTo(0.8 * 12 + 0.2 * 50, 10);
  });

  it('tracks a recognition rate between 0 and 1', () => {
    let r = updateRate(undefined, true, T);
    expect(r.ema).toBe(1);
    r = updateRate(r, false, T);
    expect(r.ema).toBeCloseTo(0.5, 10);
    for (let i = 0; i < 40; i++) r = updateRate(r, false, T);
    expect(r.ema).toBeLessThan(0.01);
    expect(r.ema).toBeGreaterThanOrEqual(0);
    expect(r.n).toBe(42);
  });
});

describe('stats from sessions', () => {
  it('routes every kind of result to the right table', () => {
    let st = emptySkillsStats();
    st = applySessionToStats(st, earSession([{ semitones: 9, direction: 'down', correct: true }, { semitones: 7, direction: 'harmonic', correct: false }]));
    st = applySessionToStats(st, degreeEarSession([{ degree: 4, mode: 'natural-minor', correct: false }]));
    st = applySessionToStats(st, singSession([{ semitones: 9, intervalCents: 30 }, { semitones: 3, direction: 'down', intervalCents: null }]));
    st = applySessionToStats(st, sequenceSession([{ degree: 7, cents: -40 }, { degree: 7, cents: -20 }], 0.5));
    st = applySessionToStats(st, pitchTestSession([{ register: 'high', heldCents: -30 }, { register: 'low', heldCents: null }]));
    st = applySessionToStats(st, matchSession([{ register: 'mid', heldCents: 8 }]));
    expect(st.hear['9d']).toMatchObject({ n: 1, ema: 1 });
    expect(st.hear['7h']).toMatchObject({ n: 1, ema: 0 });
    expect(st.hearDegree['natural-minor:4']).toMatchObject({ n: 1, ema: 0 });
    expect(st.sing['9u']).toMatchObject({ n: 1, emaSigned: 30, emaAbs: 30 });
    expect(st.sing['3d']).toBeUndefined();
    expect(st.degrees['major:7']).toMatchObject({ n: 2, emaSigned: -30, emaAbs: 30 });
    expect(st.registers.high).toMatchObject({ n: 1, emaSigned: -30 });
    expect(st.registers.low).toBeUndefined();
    expect(st.registers.mid).toMatchObject({ n: 1, emaSigned: 8 });
  });

  it('rebuilding from scratch equals recording one by one (200 random sessions)', () => {
    const rng = mulberry32(7);
    const sessions: SkillsSession[] = [];
    for (let i = 0; i < 200; i++) {
      const r = rng();
      const sem = 1 + Math.floor(rng() * 12);
      const cents = Math.round((rng() - 0.5) * 120);
      sessions.push(
        r < 0.25
          ? earSession([{ semitones: sem, direction: rng() < 0.5 ? 'up' : 'down', correct: rng() < 0.6 }], i)
          : r < 0.5
            ? singSession([{ semitones: sem, direction: rng() < 0.5 ? 'up' : 'down', intervalCents: cents }], i)
            : r < 0.75
              ? sequenceSession([{ degree: (1 + Math.floor(rng() * 7)) as 1, cents }], 0.6, i)
              : r < 0.9
                ? pitchTestSession([{ register: rng() < 0.5 ? 'low' : 'high', heldCents: cents }], i)
                : breathSession({ hissSec: 5 + rng() * 30, longToneSec: 5 + rng() * 20 }, i),
      );
    }
    let store = emptySkillsStore();
    for (const s of sessions) store = recordSkillsSession(store, s);
    const rebuilt = rebuildStats(store.sessions);
    expect(rebuilt.stats).toEqual(store.stats);
    expect(rebuilt.bests).toEqual(store.bests);
  });
});

describe('weakness', () => {
  it('is 0.5 when unseen, 1 - share for hearing and error / 50 cents for singing (capped at 1)', () => {
    let st = emptySkillsStats();
    expect(intervalWeakness(st, 7, 'up', 'hear')).toBe(0.5);
    expect(intervalWeakness(st, 7, 'up', 'sing')).toBe(0.5);
    st = applySessionToStats(st, earSession([{ semitones: 7, correct: true }, { semitones: 7, correct: false }, { semitones: 7, correct: true }, { semitones: 7, correct: true }]));
    expect(intervalWeakness(st, 7, 'up', 'hear')).toBeCloseTo(0.25, 10);
    st = applySessionToStats(st, singSession([{ semitones: 9, intervalCents: 20 }, { semitones: 10, intervalCents: -90 }]));
    expect(intervalWeakness(st, 9, 'up', 'sing')).toBeCloseTo(0.4, 10);
    expect(intervalWeakness(st, 10, 'up', 'sing')).toBe(1);
    expect(intervalWeakness(st, 9, 'harmonic', 'sing')).toBe(0.5);
    // Over directions: up 0.25, down unseen 0.5.
    expect(intervalSetWeakness(st, 7, ['up', 'down'], 'hear')).toBeCloseTo(0.375, 10);
  });

  it('gives seven degree weights with a floor, larger for degrees sung badly', () => {
    let st = emptySkillsStats();
    expect(degreeWeights(st, 'major')).toEqual([0.65, 0.65, 0.65, 0.65, 0.65, 0.65, 0.65]);
    st = applySessionToStats(st, sequenceSession([{ degree: 7, cents: -45 }, { degree: 1, cents: 0 }, { degree: 4, cents: 10 }], 0.6));
    const w = degreeWeights(st, 'major');
    expect(w).toHaveLength(7);
    expect(w[6]).toBeCloseTo(0.15 + 0.9, 10);
    expect(w[0]).toBeCloseTo(0.15, 10);
    expect(w[3]).toBeCloseTo(0.35, 10);
    // Other modes are separate.
    expect(degreeWeights(st, 'natural-minor')[6]).toBeCloseTo(0.65, 10);
  });

  it('lists the weakest intervals first, among a given set or among those measured', () => {
    let st = emptySkillsStats();
    st = applySessionToStats(
      st,
      earSession([
        { semitones: 8, direction: 'down', correct: false },
        { semitones: 5, correct: true },
        { semitones: 7, correct: false },
        { semitones: 7, correct: true },
      ]),
    );
    expect(weakestIntervals(st, 2, 'hear')).toEqual([
      { semitones: 8, direction: 'down' },
      { semitones: 7, direction: 'up' },
    ]);
    const among = [4, 5, 7].map((s) => ({ semitones: s, direction: 'up' as const }));
    // 4 up is unseen (0.5, never practised) and ties with 7 up (0.5, practised twice): the less practised one first.
    expect(weakestIntervals(st, 3, 'hear', among)).toEqual([
      { semitones: 4, direction: 'up' },
      { semitones: 7, direction: 'up' },
      { semitones: 5, direction: 'up' },
    ]);
  });
});
