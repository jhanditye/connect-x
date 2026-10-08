// Per-phrase mastery and a small spaced-repetition ladder. Pure functions; the clock is always passed in.
//
//  - Full-speed attempt: rate >= 0.9 and coverage >= 0.9 (slow practice and half-sung takes build skill but do not count).
//  - Mastered: 3 of the last 5 full-speed attempts reach 85, with pitch at 80 or more, no other component under 70 and no wrong note.
//  - Ladder 1, 3, 7, 14, 30, 60 days. A review attempt at full speed, due (or within half a day of due), moves the ladder:
//    80 or more up one rung, under 65 down two rungs (never below 1), in between waits half the current interval.
//    Extra practice before the review is due does not move the ladder.
//  - Queue for the day: due reviews (most overdue first), stuck phrases, phrases being learned (lowest last score first), new ones.

import type { PhraseSrsState } from '../types';

export interface AttemptLite {
  at: number; // ms epoch
  overall: number; // 0..100
  pitch: number;
  timing: number | null;
  tone: number | null;
  /** Optional so older callers keep working; a missing value is not held against the attempt. */
  expression?: number | null;
  rate: number; // playback speed used
  coverage: number; // 0..1
  /** Reference notes sung as a different note (>= 150 cents off). A mastered attempt has none. */
  wrongNotes: number;
  /** An attempt whose scores are not to be believed (speaker bleed) never counts. */
  trust?: 'ok' | 'caution' | 'invalid';
}

export type PhraseStatus = 'new' | 'learning' | 'mastered' | 'review-due' | 'stuck';

/** Review state of one phrase (stored on PhraseRecord.srs). */
export type PhraseSrs = PhraseSrsState;

export const MASTER_SCORE = 85;
export const MASTER_FLOOR = 70; // no timing / tone / expression component below this
/**
 * Pitch is held to a higher floor: the other three skills read 95-100 for almost any voice that is close to the original's shape
 * (tone alone was 95 or more in 94 % of 467 scored takes), so 35 % of the overall is nearly free and a take whose notes scatter by
 * 30 cents (pitch about 76) still reached 90 and counted as mastered. At 80, 8 of 8 takes with 40-cent scatter stop counting, while
 * simulated 'good' singers (25 cents) still count in 11 of 12 and careful ones in 12 of 12.
 */
export const MASTER_PITCH_FLOOR = 80;
export const MASTER_WINDOW = 5;
export const MASTER_HITS = 3;
export const MIN_MASTER_RATE = 0.9;
export const MIN_MASTER_COVERAGE = 0.9;
export const LADDER_DAYS = [1, 3, 7, 14, 30, 60];
export const REVIEW_PASS = 80;
export const REVIEW_FAIL = 65;
/** Full-speed tries that never reach this mark a phrase as stuck. */
export const STUCK_BELOW = 70;
export const STUCK_TRIES = 6;
const DAY = 86_400_000;

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Counts toward mastery and the ladder: full speed, nearly the whole phrase, and a score that can be believed. */
const full = (a: AttemptLite): boolean => a.trust !== 'invalid' && finite(a.rate) && finite(a.coverage) && a.rate >= MIN_MASTER_RATE && a.coverage >= MIN_MASTER_COVERAGE;

const byTime = (attempts: AttemptLite[]): AttemptLite[] => [...attempts].sort((a, b) => a.at - b.at);

/** A component that was not measured (null / absent) is not held against the attempt; a NaN is. */
const floorOk = (v: number | null | undefined): boolean => v === null || v === undefined || (finite(v) && v >= MASTER_FLOOR);

const isHit = (a: AttemptLite): boolean => a.wrongNotes === 0 && finite(a.overall) && a.overall >= MASTER_SCORE && finite(a.pitch) && a.pitch >= MASTER_PITCH_FLOOR && floorOk(a.timing) && floorOk(a.tone) && floorOk(a.expression);

/** The last five full-speed attempts and how many of them are good enough: "2 of 3 good attempts". */
export function masteryProgress(attempts: AttemptLite[]): { hits: number; needed: number; window: number; considered: number } {
  const last = byTime(attempts).filter(full).slice(-MASTER_WINDOW);
  return { hits: last.filter(isHit).length, needed: MASTER_HITS, window: MASTER_WINDOW, considered: last.length };
}

/** Mastered: 3 of the last 5 full-speed attempts reach 85 with pitch at 80+, no other component under 70 and no wrong note. */
export function isMastered(attempts: AttemptLite[]): boolean {
  return masteryProgress(attempts).hits >= MASTER_HITS;
}

/** Update the review state after an attempt (`attempts` oldest first, the attempt just made is the last). */
export function afterAttempt(prev: PhraseSrs, attempts: AttemptLite[], now: number): PhraseSrs {
  const ordered = byTime(attempts);
  const a = ordered[ordered.length - 1];
  if (!a) return prev;
  if (prev.rung === 0) {
    if (!isMastered(ordered)) return prev;
    return { rung: 1, dueAt: now + LADDER_DAYS[0] * DAY, masteredAt: now };
  }
  // A review attempt only counts at full speed and when it is due (or overdue); extra practice does not move the ladder.
  if (!full(a) || !finite(a.overall) || (prev.dueAt !== null && now < prev.dueAt - DAY / 2)) return prev;
  const rung = Math.max(1, Math.min(LADDER_DAYS.length, prev.rung));
  if (a.overall >= REVIEW_PASS) {
    const next = Math.min(LADDER_DAYS.length, rung + 1);
    return { ...prev, rung: next, dueAt: now + LADDER_DAYS[next - 1] * DAY };
  }
  if (a.overall < REVIEW_FAIL) {
    const down = Math.max(1, rung - 2);
    return { ...prev, rung: down, dueAt: now + LADDER_DAYS[down - 1] * DAY, masteredAt: prev.masteredAt };
  }
  return { ...prev, rung, dueAt: now + Math.max(1, LADDER_DAYS[rung - 1] / 2) * DAY };
}

export function statusOf(srs: PhraseSrs, attempts: AttemptLite[], now: number): PhraseStatus {
  if (attempts.length === 0) return 'new';
  if (srs.rung > 0) return srs.dueAt !== null && now >= srs.dueAt ? 'review-due' : 'mastered';
  const fullTries = byTime(attempts).filter(full);
  if (fullTries.length >= STUCK_TRIES && Math.max(...fullTries.slice(-STUCK_TRIES).map((x) => (finite(x.overall) ? x.overall : 0))) < STUCK_BELOW) return 'stuck';
  return 'learning';
}

export interface QueueItem {
  phraseId: string;
  status: PhraseStatus;
  reason: string;
  priority: number;
}

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** Today's practice list: due reviews (most overdue first), then stuck phrases, then phrases still being learned, then new ones. */
export function practiceQueue(
  phrases: { id: string; srs: PhraseSrs; attempts: AttemptLite[] }[],
  now: number,
  limit = 5,
): QueueItem[] {
  const items: QueueItem[] = [];
  for (const p of phrases) {
    const ordered = byTime(p.attempts);
    const status = statusOf(p.srs, ordered, now);
    const last = ordered[ordered.length - 1];
    if (status === 'review-due') {
      const overdueDays = Math.max(0, (now - (p.srs.dueAt ?? now)) / DAY);
      const whole = Math.round(overdueDays);
      items.push({ phraseId: p.id, status, reason: overdueDays >= 1 ? `Review, ${days(whole)} overdue` : 'Review due today', priority: 100 + overdueDays });
    } else if (status === 'stuck') {
      items.push({ phraseId: p.id, status, reason: 'Stuck: try it at 75% speed', priority: 70 });
    } else if (status === 'learning') {
      const lastScore = last && finite(last.overall) ? last.overall : null;
      items.push({
        phraseId: p.id,
        status,
        reason: lastScore !== null ? `Last ${Math.round(lastScore)}, aim for ${MASTER_SCORE}` : 'Keep going',
        priority: 50 + (lastScore !== null ? (MASTER_SCORE - lastScore) / 10 : 0),
      });
    } else if (status === 'new') {
      items.push({ phraseId: p.id, status, reason: 'Not tried yet', priority: 30 });
    }
  }
  return items.sort((a, b) => b.priority - a.priority).slice(0, Math.max(0, limit));
}

export interface NextStep {
  /** Suggest the same phrase at 75% speed (a poor score at full speed). */
  slower: boolean;
  /** Suggest going back to full speed (a good score at 75 %). */
  faster: boolean;
  /** Offer "Next phrase" (three tries this visit, or mastered). */
  next: boolean;
}

/**
 * What to offer under the result. "Try again" is always the primary button; this decides the extras:
 * under 60 at full speed suggests 75 %, 85 or more at 75 % suggests full speed, and after three tries in a visit or once
 * the phrase is mastered "Next phrase" appears. A take that could not be scored suggests nothing.
 */
export function nextStep(opts: { overall: number | null; rate: number; triesThisVisit: number; mastered: boolean }): NextStep {
  const { overall, rate } = opts;
  const scored = overall !== null && finite(overall);
  return {
    slower: scored && rate >= 0.9 && (overall as number) < 60,
    faster: scored && rate < 0.9 && (overall as number) >= MASTER_SCORE,
    next: opts.mastered || opts.triesThisVisit >= 3,
  };
}
