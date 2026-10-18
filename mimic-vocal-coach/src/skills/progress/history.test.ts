import { describe, expect, it } from 'vitest';
import { emptySkillsStore, recordSkillsSession } from './store';
import { degreeProfile, degreeTendencies, intervalTable, lastSessionOf, metricSeries, practiceDays, registerTable, sessionHeadline, SKILLS_METRICS } from './history';
import { breathSession, earSession, matchSession, pitchTestSession, sequenceSession, singSession, workoutSession } from './testKit';

function sample() {
  let s = emptySkillsStore();
  const list = [
    pitchTestSession([{ register: 'low', heldCents: -10 }, { register: 'high', heldCents: -30 }], 1, 'p1'),
    earSession([{ semitones: 7, correct: true }, { semitones: 5, correct: false }, { semitones: 4, correct: true }, { semitones: 12, correct: true }], 2, 'e1'),
    singSession([{ semitones: 9, intervalCents: 30 }, { semitones: 4, direction: 'down', intervalCents: -10 }], 3, 's1'),
    sequenceSession([{ degree: 7, cents: -40 }, { degree: 6, cents: 5 }], 0.5, 4, 'q1'),
    breathSession({ hissSec: 18, longToneSec: 12 }, 5, 'b1'),
    pitchTestSession([{ register: 'low', heldCents: 4 }, { register: 'mid', heldCents: null }], 6, 'p2'),
    matchSession([{ register: 'mid', heldCents: 5 }, { register: 'mid', heldCents: null, locked: false }], 7, 'm1'),
    workoutSession(['m1'], 8, 'w1'),
  ];
  for (const x of list) s = recordSkillsSession(s, x);
  return s;
}

describe('metricSeries', () => {
  it('gives one point per session that has the measure, oldest first', () => {
    const s = sample();
    expect(metricSeries(s.sessions, 'pitch-mean-abs-cents').map((p) => p.value)).toEqual([20, 4]);
    expect(metricSeries(s.sessions, 'ear-accuracy')).toEqual([{ at: s.sessions[1].at, value: 0.75 }]);
    expect(metricSeries(s.sessions, 'interval-abs-cents')[0].value).toBe(20);
    expect(metricSeries(s.sessions, 'sequence-accuracy')[0].value).toBe(0.5);
    expect(metricSeries(s.sessions, 'hiss-sec')[0].value).toBe(18);
    expect(metricSeries(s.sessions, 'long-tone-sec')[0].value).toBe(12);
    for (const m of SKILLS_METRICS) expect(metricSeries([], m)).toEqual([]);
  });
});

describe('tables', () => {
  it('builds the interval table, degree profile and register table from the stats', () => {
    const s = sample();
    const rows = intervalTable(s.stats);
    expect(rows).toHaveLength(12);
    const p5 = rows.find((r) => r.semitones === 7);
    expect(p5).toMatchObject({ short: 'P5', name: 'perfect 5th', hearDown: null, singUp: null });
    expect(p5?.hearUp?.ema).toBe(1);
    expect(rows.find((r) => r.semitones === 4)?.singDown?.emaSigned).toBe(-10);
    const prof = degreeProfile(s.stats, 'major');
    expect(prof.map((r) => r.degree)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(prof[6]).toMatchObject({ n: 1, signedCents: -40, absCents: 40 });
    expect(prof[0]).toMatchObject({ n: 0, signedCents: null });
    const regs = registerTable(s.stats);
    expect(regs.map((r) => r.register)).toEqual(['low', 'mid', 'high']);
    expect(regs[0]).toMatchObject({ n: 2 });
    expect(regs[1]).toMatchObject({ n: 1, signedCents: 5 });
  });

  it('names degree habits only with enough notes and a clear lean', () => {
    let s = emptySkillsStore();
    s = recordSkillsSession(s, sequenceSession([{ degree: 7, cents: -20 }, { degree: 7, cents: -20 }, { degree: 4, cents: 15 }], 0.6, 0, 'a'));
    expect(degreeTendencies(s.stats, 'major')).toEqual([]);
    for (let i = 1; i < 5; i++) s = recordSkillsSession(s, sequenceSession([{ degree: 7, cents: -20 }, { degree: 4, cents: 15 }, { degree: 1, cents: 3 }], 0.6, i, `b${i}`));
    expect(degreeTendencies(s.stats, 'major').map((f) => f.text)).toEqual(['Your 7 tends to sit 20 cents flat (over 6 notes).', 'Your 4 tends to sit 15 cents sharp (over 5 notes).']);
  });
});

describe('headlines and practice days', () => {
  it('summarises a session in plain words', () => {
    const s = sample();
    expect(sessionHeadline(s.sessions[0]).text).toBe('20 cents off on average');
    expect(sessionHeadline(s.sessions[1]).text).toBe('3 of 4 right');
    expect(sessionHeadline(s.sessions[3]).text).toBe('50% of notes in tune');
    expect(sessionHeadline(s.sessions[4]).text).toBe('Steady hiss for 18 s');
    expect(sessionHeadline(s.sessions[6]).text).toBe('Locked in on 1 of 2 notes');
    expect(lastSessionOf(s.sessions, 'pitch-test')?.id).toBe('p2');
    expect(lastSessionOf(s.sessions, 'sequence')?.id).toBe('q1');
  });

  it('counts days, the current streak and the last week', () => {
    const day = (d: number, h = 10) => new Date(2026, 9, d, h).toISOString();
    const mk = (d: number, id: string) => ({ ...earSession([{ semitones: 7, correct: true }], 0, id), at: day(d) });
    const sessions = [mk(1, 'a'), mk(10, 'b'), mk(11, 'c'), mk(11, 'c2'), mk(12, 'd'), { ...workoutSession([], 0, 'w'), at: day(13) }];
    expect(practiceDays(sessions, new Date(2026, 9, 12, 20))).toEqual({ days: 4, streak: 3, last7: 4, practisedToday: true });
    // The next day, nothing yet: the streak is still alive (workout wrappers alone do not count).
    expect(practiceDays(sessions, new Date(2026, 9, 13, 9))).toMatchObject({ streak: 3, practisedToday: false });
    // Two days later it has lapsed.
    expect(practiceDays(sessions, new Date(2026, 9, 14, 9)).streak).toBe(0);
  });
});
