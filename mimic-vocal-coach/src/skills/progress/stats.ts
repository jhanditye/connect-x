// Moving statistics and personal bests, derived from sessions (src/skills/SPEC.md section 5).
//
// Each stat is an exponential moving average with alpha = max(0.2, 1/n): the first five values are a plain running
// mean, after that each new value counts 20 % (roughly "the last ten or so count most"). Stats can always be rebuilt
// from the sessions in time order; doing it one session at a time gives the same numbers.

import { intervalKey, parseIntervalKey } from '../theory/intervals';
import { DEGREES } from '../theory/scales';
import type {
  BestRecord,
  CentsStat,
  Degree,
  DegreeKey,
  IntervalDirection,
  IntervalKey,
  RateStat,
  ScaleMode,
  SkillsBests,
  SkillsSession,
  SkillsStats,
  SungDirection,
} from '../types';
import { emptySkillsBests, emptySkillsStats } from './parse';

/** Smallest weight a new value gets once n >= 5. */
export const EMA_ALPHA_MIN = 0.2;
/** Unseen items are assumed middling. */
export const UNSEEN_WEAKNESS = 0.5;
/** Average interval/degree error (cents) that counts as fully weak (a quarter tone off on average). */
export const WEAK_CENTS = 50;
/** Floor added to degree weakness so no degree ever disappears from generated lines. */
export const DEGREE_WEIGHT_FLOOR = 0.15;

const alphaFor = (n: number): number => Math.max(EMA_ALPHA_MIN, 1 / n);

export function updateRate(s: RateStat | undefined, correct: boolean, at: string): RateStat {
  const n = (s?.n ?? 0) + 1;
  const a = alphaFor(n);
  const v = correct ? 1 : 0;
  const ema = s ? s.ema + a * (v - s.ema) : v;
  return { n, ema: Math.min(1, Math.max(0, ema)), lastAt: at };
}

export function updateCents(s: CentsStat | undefined, cents: number, at: string): CentsStat {
  const n = (s?.n ?? 0) + 1;
  const a = alphaFor(n);
  const emaSigned = s ? s.emaSigned + a * (cents - s.emaSigned) : cents;
  const emaAbs = s ? s.emaAbs + a * (Math.abs(cents) - s.emaAbs) : Math.abs(cents);
  return { n, emaSigned, emaAbs: Math.max(0, emaAbs), lastAt: at };
}

export function degreeKey(mode: ScaleMode, degree: Degree): DegreeKey {
  return `${mode}:${degree}` as DegreeKey;
}

function cloneStats(s: SkillsStats): SkillsStats {
  return { hear: { ...s.hear }, sing: { ...s.sing }, hearDegree: { ...s.hearDegree }, degrees: { ...s.degrees }, registers: { ...s.registers } };
}

/** A note this far from the target is a different note, not a tuning error (same as the scorers' WRONG_NOTE_CENTS). */
export const WRONG_NOTE_CENTS = 70;
/** Sung-interval errors are capped at this for the running average (a semitone). */
export const WRONG_INTERVAL_CAP_CENTS = 100;

/** Stats after one more session (pure; `stats` is not changed). */
export function applySessionToStats(stats: SkillsStats, session: SkillsSession): SkillsStats {
  const out = cloneStats(stats);
  const at = session.at;
  switch (session.kind) {
    case 'pitch-test':
      for (const n of session.notes) {
        // A different note (70+ cents away) is a listening slip, not a register's tuning: kept out.
        if (n.status === 'ok' && n.heldCents !== null && Math.abs(n.heldCents) < WRONG_NOTE_CENTS) {
          out.registers[n.register] = updateCents(out.registers[n.register], n.heldCents, at);
        }
      }
      break;
    case 'match':
      for (const a of session.attempts) {
        if (a.heldCents !== null && Math.abs(a.heldCents) < WRONG_NOTE_CENTS) out.registers[a.register] = updateCents(out.registers[a.register], a.heldCents, at);
      }
      break;
    case 'ear':
      for (const a of session.answers) {
        if (a.kind === 'interval') {
          const k = intervalKey(a.correctValue, a.direction ?? 'up');
          out.hear[k] = updateRate(out.hear[k], a.correct, at);
        } else if (a.mode !== null && a.correctValue >= 1 && a.correctValue <= 7) {
          const k = degreeKey(a.mode, a.correctValue as Degree);
          out.hearDegree[k] = updateRate(out.hearDegree[k], a.correct, at);
        }
      }
      break;
    case 'sing-intervals':
      for (const i of session.items) {
        if (i.status !== 'ok' || i.intervalCents === null) continue;
        const k = intervalKey(i.semitones, i.direction);
        // A different interval (wrong size, wrong direction or wrong octave) counts as a semitone off: it still marks
        // the interval as weak, but one 1200-cent slip cannot swamp the average (and is never folded to "in tune").
        const c = Math.max(-WRONG_INTERVAL_CAP_CENTS, Math.min(WRONG_INTERVAL_CAP_CENTS, i.intervalCents));
        out.sing[k] = updateCents(out.sing[k], c, at);
      }
      break;
    case 'sequence':
      for (const item of session.items) {
        if (item.status !== 'ok') continue;
        for (const p of item.perNote) {
          // Wrong notes are not a degree's tuning habit (the screens leave them out too; this guards old sessions).
          if (!Number.isFinite(p.cents) || Math.abs(p.cents) >= WRONG_NOTE_CENTS) continue;
          const k = degreeKey(item.scaleMode, p.degree);
          out.degrees[k] = updateCents(out.degrees[k], p.cents, at);
        }
      }
      break;
    case 'breath':
    case 'workout':
      break;
  }
  return out;
}

function better(prev: BestRecord | null, value: number | null, at: string): BestRecord | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return prev;
  return prev === null || value > prev.value ? { value, at } : prev;
}

/** Personal bests after one more session (only scored takes count). */
export function applySessionToBests(bests: SkillsBests, session: SkillsSession): SkillsBests {
  if (session.kind !== 'breath') return bests;
  return {
    hissSec: better(bests.hissSec, session.hiss && session.hiss.status === 'ok' ? session.hiss.durationSec : null, session.at),
    longToneSec: better(bests.longToneSec, session.longTone && session.longTone.status === 'ok' ? session.longTone.durationSec : null, session.at),
    pacedExhaleCounts: better(bests.pacedExhaleCounts, session.paced && session.paced.rounds > 0 ? session.paced.maxExhaleCounts : null, session.at),
  };
}

/** The larger of two bests (the earlier one on a tie). */
export function maxBest(a: BestRecord | null, b: BestRecord | null): BestRecord | null {
  if (!a) return b;
  if (!b) return a;
  if (b.value > a.value) return b;
  if (a.value > b.value) return a;
  return Date.parse(b.at) < Date.parse(a.at) ? b : a;
}

export function mergeBests(a: SkillsBests, b: SkillsBests): SkillsBests {
  return {
    hissSec: maxBest(a.hissSec, b.hissSec),
    longToneSec: maxBest(a.longToneSec, b.longToneSec),
    pacedExhaleCounts: maxBest(a.pacedExhaleCounts, b.pacedExhaleCounts),
  };
}

/** Stats and bests from scratch, sessions applied in time order (the caller passes them oldest first). */
export function rebuildStats(sessions: SkillsSession[]): { stats: SkillsStats; bests: SkillsBests } {
  let stats = emptySkillsStats();
  let bests = emptySkillsBests();
  for (const s of sessions) {
    stats = applySessionToStats(stats, s);
    bests = applySessionToBests(bests, s);
  }
  return { stats, bests };
}

// ---------------------------------------------------------------------------------------------
// Weakness (0 = solid, 1 = needs the most work)

/**
 * How weak an interval is for hearing ('hear': 1 - moving share correct) or singing ('sing': moving average size error
 * / 50 cents, capped at 1). Unseen items are 0.5. Singing has no 'harmonic' stats (0.5).
 */
export function intervalWeakness(stats: SkillsStats, semitones: number, direction: IntervalDirection, kind: 'hear' | 'sing'): number {
  const k = intervalKey(semitones, direction);
  if (kind === 'hear') {
    const s = stats.hear[k];
    return s ? clamp01(1 - s.ema) : UNSEEN_WEAKNESS;
  }
  const s = stats.sing[k];
  return s ? clamp01(s.emaAbs / WEAK_CENTS) : UNSEEN_WEAKNESS;
}

/** Mean weakness of an interval over several directions (e.g. the singer's chosen ear-training directions). */
export function intervalSetWeakness(stats: SkillsStats, semitones: number, directions: readonly IntervalDirection[], kind: 'hear' | 'sing'): number {
  const dirs = kind === 'sing' ? directions.filter((d): d is SungDirection => d !== 'harmonic') : directions;
  const use = dirs.length > 0 ? dirs : (['up', 'down'] as IntervalDirection[]);
  return use.reduce((sum, d) => sum + intervalWeakness(stats, semitones, d, kind), 0) / use.length;
}

/** How weak a sung scale degree is: moving average |cents| / 50, capped at 1; unseen 0.5. */
export function degreeWeakness(stats: SkillsStats, mode: ScaleMode, degree: Degree): number {
  const s = stats.degrees[degreeKey(mode, degree)];
  return s ? clamp01(s.emaAbs / WEAK_CENTS) : UNSEEN_WEAKNESS;
}

/** Seven weights (degrees 1..7) for theory randomLine: 0.15 + weakness, so weak degrees come up more often. */
export function degreeWeights(stats: SkillsStats, mode: ScaleMode): number[] {
  return DEGREES.map((d) => DEGREE_WEIGHT_FLOOR + degreeWeakness(stats, mode, d));
}

/**
 * The `n` weakest intervals, weakest first. Candidates are `among` when given (unseen ones count 0.5), otherwise every
 * interval with stats of that kind. Ties go to the less practised one, then the smaller interval.
 */
export function weakestIntervals(
  stats: SkillsStats,
  n: number,
  kind: 'hear' | 'sing',
  among?: readonly { semitones: number; direction: IntervalDirection }[],
): { semitones: number; direction: IntervalDirection }[] {
  const table = kind === 'hear' ? stats.hear : stats.sing;
  const cands =
    among ??
    Object.keys(table).flatMap((k) => {
      const p = parseIntervalKey(k);
      return p ? [p] : [];
    });
  const seen = new Set<string>();
  const rows = cands
    .filter((c) => {
      const k = intervalKey(c.semitones, c.direction);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({
      c: { semitones: Math.abs(Math.round(c.semitones)), direction: c.direction },
      w: intervalWeakness(stats, c.semitones, c.direction, kind),
      n: table[intervalKey(c.semitones, c.direction) as IntervalKey]?.n ?? 0,
    }));
  rows.sort((a, b) => b.w - a.w || a.n - b.n || a.c.semitones - b.c.semitones || a.c.direction.localeCompare(b.c.direction));
  return rows.slice(0, Math.max(0, Math.round(n))).map((r) => r.c);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : UNSEEN_WEAKNESS;
}
