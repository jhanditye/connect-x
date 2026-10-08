// What state a phrase is in, read from what is stored on the PhraseRecord (srs + stats), for the library, the clip detail and
// Progress. The review ladder itself lives in trainer/srs.ts; this only names the result. The "stuck" test in srs.ts reads the last
// six full-speed attempts; the stored stats keep the last five scores of any speed, so stuck here needs six full-speed tries and
// five recent scores that never reached the mark. Pure functions; the clock is passed in.

import { STUCK_BELOW, STUCK_TRIES, type PhraseStatus } from '../../trainer/srs';
import type { ClipRecord, PhraseRecord } from '../../types';

export const STATUS_LABEL: Record<PhraseStatus, string> = {
  new: 'New',
  learning: 'Learning',
  mastered: 'Mastered',
  'review-due': 'Review due',
  stuck: 'Stuck',
};

/** One sentence per status for screen readers and tooltips. */
export const STATUS_HINT: Record<PhraseStatus, string> = {
  new: 'Not tried yet.',
  learning: 'Being learned: keep going until three good full-speed tries.',
  mastered: 'Mastered: it comes back for review later.',
  'review-due': 'Mastered before, and due for a review today.',
  stuck: 'Six full-speed tries have not got past 70. Try it slower, or loop the weakest part.',
};

export function phraseStatus(p: PhraseRecord, now: number): PhraseStatus {
  if (p.stats.attempts === 0) return 'new';
  if (p.srs.rung > 0) return p.srs.dueAt !== null && now >= p.srs.dueAt ? 'review-due' : 'mastered';
  const recent = p.stats.recent.filter((x) => Number.isFinite(x));
  if (p.stats.fullSpeedAttempts >= STUCK_TRIES && recent.length > 0 && Math.max(...recent) < STUCK_BELOW) return 'stuck';
  return 'learning';
}

/** Phrases that take part in practice (the user can hide fragments and short bits). */
export function visiblePhrases(clip: ClipRecord): PhraseRecord[] {
  return clip.phrases.filter((p) => !p.hidden);
}

export interface ClipSummary {
  /** Visible phrases. */
  total: number;
  hidden: number;
  /** Mastered, including the ones due for a review. */
  mastered: number;
  reviewDue: number;
  learning: number;
  stuck: number;
  fresh: number;
}

export function summariseClip(clip: ClipRecord, now: number): ClipSummary {
  const s: ClipSummary = { total: 0, hidden: 0, mastered: 0, reviewDue: 0, learning: 0, stuck: 0, fresh: 0 };
  for (const p of clip.phrases) {
    if (p.hidden) {
      s.hidden++;
      continue;
    }
    s.total++;
    switch (phraseStatus(p, now)) {
      case 'mastered':
        s.mastered++;
        break;
      case 'review-due':
        s.mastered++;
        s.reviewDue++;
        break;
      case 'learning':
        s.learning++;
        break;
      case 'stuck':
        s.learning++;
        s.stuck++;
        break;
      case 'new':
        s.fresh++;
        break;
    }
  }
  return s;
}

/** "12 phrases", "1 phrase". */
export function phraseCount(n: number): string {
  return `${n} phrase${n === 1 ? '' : 's'}`;
}

/** The number shown for a phrase everywhere on screen and in deep links: its position in the clip, counting from 1. */
export function phraseNumber(p: Pick<PhraseRecord, 'index'>): number {
  return p.index + 1;
}

/** The phrase for a deep link's number, or undefined. */
export function phraseByNumber(clip: ClipRecord, n: number): PhraseRecord | undefined {
  return clip.phrases.find((p) => p.index + 1 === n);
}

/** Next and previous visible phrase around `phrase` (null at the ends). */
export function neighbours(clip: ClipRecord, phrase: PhraseRecord): { prev: PhraseRecord | null; next: PhraseRecord | null } {
  const list = visiblePhrases(clip);
  const i = list.findIndex((p) => p.id === phrase.id);
  if (i === -1) {
    // A hidden phrase opened by a deep link: step to the nearest visible ones around it.
    return { prev: [...list].reverse().find((p) => p.index < phrase.index) ?? null, next: list.find((p) => p.index > phrase.index) ?? null };
  }
  return { prev: list[i - 1] ?? null, next: list[i + 1] ?? null };
}

/** "3:35" for a clip, "7 s" for a phrase. */
export function clipLength(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function phraseLength(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
}
