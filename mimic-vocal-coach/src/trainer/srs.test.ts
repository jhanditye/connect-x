import { describe, expect, it } from 'vitest';
import {
  LADDER_DAYS, MASTER_FLOOR, MASTER_PITCH_FLOOR, afterAttempt, isMastered, masteryProgress, nextStep, practiceQueue, statusOf, type AttemptLite, type PhraseSrs,
} from './srs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 8, 12);
const att = (overall: number, at: number, over: Partial<AttemptLite> = {}): AttemptLite => ({
  at, overall, pitch: overall, timing: overall, tone: overall, expression: overall, rate: 1, coverage: 1, wrongNotes: 0, ...over,
});
const fresh = (): PhraseSrs => ({ rung: 0, dueAt: null, masteredAt: null });

describe('mastery', () => {
  it('needs 3 of the last 5 full-speed attempts at 85 or more', () => {
    expect(isMastered([att(90, T0), att(88, T0 + 1), att(60, T0 + 2)])).toBe(false);
    expect(isMastered([att(90, T0), att(88, T0 + 1), att(86, T0 + 2)])).toBe(true);
    expect(isMastered([att(90, T0), att(60, T0 + 1), att(88, T0 + 2), att(50, T0 + 3), att(86, T0 + 4)])).toBe(true);
    expect(isMastered([att(84, T0), att(84, T0 + 1), att(84, T0 + 2), att(99, T0 + 3), att(99, T0 + 4)])).toBe(false);
  });

  it('old hits fall out of the window of five', () => {
    expect(isMastered([att(95, T0), att(95, T0 + 1), att(95, T0 + 2), att(60, T0 + 3), att(55, T0 + 4), att(50, T0 + 5), att(40, T0 + 6)])).toBe(false);
  });

  it('slow practice and half-sung takes do not count', () => {
    expect(isMastered([att(95, T0, { rate: 0.75 }), att(95, T0 + 1, { rate: 0.75 }), att(95, T0 + 2, { rate: 0.75 })])).toBe(false);
    expect(isMastered([att(95, T0, { coverage: 0.5 }), att(95, T0 + 1, { coverage: 0.5 }), att(95, T0 + 2, { coverage: 0.5 })])).toBe(false);
    expect(isMastered([att(95, T0, { rate: 0.9 }), att(95, T0 + 1, { rate: 0.9 }), att(95, T0 + 2, { rate: 0.9 })])).toBe(true);
  });

  it('a wrong note blocks a hit', () => {
    const w = (o: number, at: number): AttemptLite => att(o, at, { wrongNotes: 1 });
    expect(isMastered([w(95, T0), w(95, T0 + 1), w(95, T0 + 2)])).toBe(false);
  });

  it('no timing, tone or expression under 70 and no pitch under 80: each holds a hit back', () => {
    for (const weak of ['pitch', 'timing', 'tone', 'expression'] as const) {
      const floor = weak === 'pitch' ? MASTER_PITCH_FLOOR : MASTER_FLOOR;
      const bad = (at: number): AttemptLite => att(90, at, { [weak]: floor - 1 });
      expect(isMastered([bad(T0), bad(T0 + 1), bad(T0 + 2)]), weak).toBe(false);
      const edge = (at: number): AttemptLite => att(90, at, { [weak]: floor });
      expect(isMastered([edge(T0), edge(T0 + 1), edge(T0 + 2)]), weak).toBe(true);
    }
    expect(MASTER_PITCH_FLOOR).toBe(80);
    expect(MASTER_FLOOR).toBe(70);
  });

  it('pitch scattered by about 30 cents (pitch near 76) no longer masters a phrase, however good tone and timing are', () => {
    const loose = (at: number): AttemptLite => att(90, at, { pitch: 76, timing: 100, tone: 100, expression: 98 });
    expect(isMastered([loose(T0), loose(T0 + 1), loose(T0 + 2)])).toBe(false);
  });

  it('a component that was not measured (a mix clip has no tone) is not held against the attempt', () => {
    const noTone = (at: number): AttemptLite => att(90, at, { tone: null, expression: null });
    expect(isMastered([noTone(T0), noTone(T0 + 1), noTone(T0 + 2)])).toBe(true);
  });

  it('an attempt without the optional fields (older callers) still works', () => {
    const old = (o: number, at: number): AttemptLite => ({ at, overall: o, pitch: o, timing: o, tone: o, rate: 1, coverage: 1, wrongNotes: 0 });
    expect(isMastered([old(90, T0), old(90, T0 + 1), old(90, T0 + 2)])).toBe(true);
  });

  it('an attempt whose score cannot be believed (speaker bleed) never counts; NaN is not a hit', () => {
    const bleed = (at: number): AttemptLite => att(100, at, { trust: 'invalid' });
    expect(isMastered([bleed(T0), bleed(T0 + 1), bleed(T0 + 2)])).toBe(false);
    expect(isMastered([att(Number.NaN, T0), att(Number.NaN, T0 + 1), att(Number.NaN, T0 + 2)])).toBe(false);
    expect(isMastered([att(90, T0, { trust: 'caution' }), att(90, T0 + 1, { trust: 'caution' }), att(90, T0 + 2, { trust: 'caution' })])).toBe(true);
  });

  it('attempts are read in time order whatever order they arrive in', () => {
    const list = [att(60, T0 + 5), att(90, T0), att(90, T0 + 1), att(90, T0 + 2)];
    expect(isMastered(list)).toBe(true);
    expect(masteryProgress(list)).toEqual({ hits: 3, needed: 3, window: 5, considered: 4 });
  });

  it('progress reads "2 of 3 good attempts"', () => {
    expect(masteryProgress([att(90, T0), att(50, T0 + 1), att(88, T0 + 2)])).toEqual({ hits: 2, needed: 3, window: 5, considered: 3 });
    expect(masteryProgress([])).toEqual({ hits: 0, needed: 3, window: 5, considered: 0 });
  });
});

describe('the review ladder', () => {
  function master(now: number): { srs: PhraseSrs; attempts: AttemptLite[] } {
    const attempts: AttemptLite[] = [];
    let srs = fresh();
    for (const [i, s] of [90, 88, 87].entries()) {
      attempts.push(att(s, now + i));
      srs = afterAttempt(srs, attempts, now + i);
    }
    return { srs, attempts };
  }

  it('mastery starts the ladder at rung 1: due in a day', () => {
    const { srs } = master(T0);
    expect(srs.rung).toBe(1);
    expect(srs.dueAt).toBe(T0 + 2 + DAY);
    expect(srs.masteredAt).toBe(T0 + 2);
  });

  it('the ladder is 1, 3, 7, 14, 30, 60 days', () => {
    expect(LADDER_DAYS).toEqual([1, 3, 7, 14, 30, 60]);
  });

  it('extra practice before the review is due does not move the ladder', () => {
    const { srs, attempts } = master(T0);
    const later = T0 + 3600_000;
    attempts.push(att(95, later));
    expect(afterAttempt(srs, attempts, later)).toEqual(srs);
  });

  it('a pass moves up one rung, a fail drops two (never below 1), a middling score waits half the interval', () => {
    let now = T0;
    const { srs: s1, attempts } = master(now);
    let srs = s1;
    // review at the due time: 88 -> rung 2 (3 days)
    now += DAY + 10;
    attempts.push(att(88, now));
    srs = afterAttempt(srs, attempts, now);
    expect(srs.rung).toBe(2);
    expect(srs.dueAt).toBe(now + 3 * DAY);
    // 72: neither pass nor fail: due again after half of the 3 days
    now += 3 * DAY;
    attempts.push(att(72, now));
    srs = afterAttempt(srs, attempts, now);
    expect(srs.rung).toBe(2);
    expect(srs.dueAt).toBe(now + 1.5 * DAY);
    // 60: back down two rungs, clamped at 1
    now += 1.5 * DAY;
    attempts.push(att(60, now));
    srs = afterAttempt(srs, attempts, now);
    expect(srs.rung).toBe(1);
    expect(srs.dueAt).toBe(now + DAY);
    expect(statusOf(srs, attempts, now)).toBe('mastered');
    expect(statusOf(srs, attempts, now + DAY + 1)).toBe('review-due');
  });

  it('the top rung stays at 60 days and a fail from rung 6 lands on rung 4', () => {
    const attempts: AttemptLite[] = [];
    let srs: PhraseSrs = { rung: 6, dueAt: T0, masteredAt: T0 - 100 * DAY };
    attempts.push(att(95, T0));
    srs = afterAttempt(srs, attempts, T0);
    expect(srs.rung).toBe(6);
    expect(srs.dueAt).toBe(T0 + 60 * DAY);
    srs = { rung: 6, dueAt: T0, masteredAt: 1 };
    attempts.push(att(50, T0 + 1));
    srs = afterAttempt(srs, attempts, T0 + 1);
    expect(srs.rung).toBe(4);
    expect(srs.masteredAt).toBe(1);
  });

  it('a review at slow speed or half-sung, or an unbelievable one, does not move the ladder', () => {
    const base: PhraseSrs = { rung: 2, dueAt: T0, masteredAt: 1 };
    for (const a of [att(95, T0, { rate: 0.75 }), att(95, T0, { coverage: 0.4 }), att(95, T0, { trust: 'invalid' }), att(Number.NaN, T0)]) {
      expect(afterAttempt(base, [a], T0)).toEqual(base);
    }
  });

  it('no attempts changes nothing', () => {
    expect(afterAttempt(fresh(), [], T0)).toEqual(fresh());
  });

  it('half a day before the due time a review already counts; earlier it does not', () => {
    const base: PhraseSrs = { rung: 1, dueAt: T0 + DAY, masteredAt: 1 };
    expect(afterAttempt(base, [att(90, T0 + DAY / 2 + 1)], T0 + DAY / 2 + 1).rung).toBe(2);
    expect(afterAttempt(base, [att(90, T0 + DAY / 2 - 1)], T0 + DAY / 2 - 1)).toEqual(base);
  });
});

describe('status', () => {
  it('new, learning, stuck, mastered, review-due', () => {
    expect(statusOf(fresh(), [], T0)).toBe('new');
    expect(statusOf(fresh(), [att(60, T0)], T0)).toBe('learning');
    const stuck = [52, 58, 61, 55, 66, 63].map((o, i) => att(o, T0 + i));
    expect(statusOf(fresh(), stuck, T0)).toBe('stuck');
    expect(statusOf(fresh(), [...stuck, att(75, T0 + 9)], T0)).toBe('learning'); // the best of the last six is now 75
    expect(statusOf({ rung: 2, dueAt: T0 + DAY, masteredAt: 1 }, [att(90, T0)], T0)).toBe('mastered');
    expect(statusOf({ rung: 2, dueAt: T0 - 1, masteredAt: 1 }, [att(90, T0)], T0)).toBe('review-due');
  });

  it('six slow tries are not "stuck": only full-speed tries count', () => {
    const slow = Array.from({ length: 8 }, (_, i) => att(50, T0 + i, { rate: 0.6 }));
    expect(statusOf(fresh(), slow, T0)).toBe('learning');
  });
});

describe('the practice queue', () => {
  const now = Date.UTC(2026, 9, 20);

  it('due reviews (most overdue first), then stuck, then learning (lowest last score first), then new', () => {
    const stuck = [52, 58, 61, 55, 66, 63].map((o, i) => att(o, now - (10 - i) * DAY));
    const q = practiceQueue(
      [
        { id: 'new', srs: fresh(), attempts: [] },
        { id: 'learn-70', srs: fresh(), attempts: [att(62, now - DAY), att(70, now - DAY + 1)] },
        { id: 'learn-40', srs: fresh(), attempts: [att(40, now - DAY)] },
        { id: 'stuck', srs: fresh(), attempts: stuck },
        { id: 'due-1', srs: { rung: 2, dueAt: now - 1 * DAY, masteredAt: 1 }, attempts: [att(90, now - 5 * DAY)] },
        { id: 'due-3', srs: { rung: 2, dueAt: now - 3 * DAY, masteredAt: 1 }, attempts: [att(90, now - 8 * DAY)] },
        { id: 'fine', srs: { rung: 1, dueAt: now + 2 * DAY, masteredAt: now - DAY }, attempts: [att(92, now - DAY)] },
      ],
      now,
      10,
    );
    expect(q.map((i) => i.phraseId)).toEqual(['due-3', 'due-1', 'stuck', 'learn-40', 'learn-70', 'new']);
    expect(q[0].reason).toBe('Review, 3 days overdue');
    expect(q[1].reason).toBe('Review, 1 day overdue');
    expect(q[2].reason).toBe('Stuck: try it at 75% speed');
    expect(q[3].reason).toBe('Last 40, aim for 85');
    expect(q[5].reason).toBe('Not tried yet');
  });

  it('a review due within the day says so; mastered phrases that are not due stay out; the limit applies', () => {
    const q = practiceQueue(
      [
        { id: 'today', srs: { rung: 1, dueAt: now - 3600_000, masteredAt: 1 }, attempts: [att(90, now - DAY)] },
        { id: 'later', srs: { rung: 1, dueAt: now + DAY, masteredAt: 1 }, attempts: [att(90, now - DAY)] },
        { id: 'a', srs: fresh(), attempts: [] },
        { id: 'b', srs: fresh(), attempts: [] },
      ],
      now,
      2,
    );
    expect(q.map((i) => i.phraseId)).toEqual(['today', 'a']);
    expect(q[0].reason).toBe('Review due today');
    expect(practiceQueue([], now)).toEqual([]);
    expect(practiceQueue([{ id: 'a', srs: fresh(), attempts: [] }], now, 0)).toEqual([]);
  });

  it('uses the latest attempt even when the history arrives out of order', () => {
    const q = practiceQueue([{ id: 'a', srs: fresh(), attempts: [att(80, now), att(30, now - 5 * DAY)] }], now);
    expect(q[0].reason).toBe('Last 80, aim for 85');
  });
});

describe('what to offer under a result', () => {
  it('slower under 60 at full speed, faster at 85 or more at 75 %, next phrase after three tries or mastery', () => {
    expect(nextStep({ overall: 55, rate: 1, triesThisVisit: 1, mastered: false })).toEqual({ slower: true, faster: false, next: false });
    expect(nextStep({ overall: 55, rate: 0.75, triesThisVisit: 1, mastered: false }).slower).toBe(false);
    expect(nextStep({ overall: 88, rate: 0.75, triesThisVisit: 2, mastered: false })).toEqual({ slower: false, faster: true, next: false });
    expect(nextStep({ overall: 88, rate: 1, triesThisVisit: 3, mastered: false })).toEqual({ slower: false, faster: false, next: true });
    expect(nextStep({ overall: 70, rate: 1, triesThisVisit: 1, mastered: true }).next).toBe(true);
  });

  it('a take that could not be scored suggests no speed change', () => {
    expect(nextStep({ overall: null, rate: 1, triesThisVisit: 1, mastered: false })).toEqual({ slower: false, faster: false, next: false });
    expect(nextStep({ overall: Number.NaN, rate: 1, triesThisVisit: 1, mastered: false }).slower).toBe(false);
  });
});
