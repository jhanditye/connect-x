// Selectors for the Skills progress screen and the hub cards (src/skills/SPEC.md sections 5 and 6): one time series per
// measure, the per-interval table, the per-degree tuning profile, per-register accuracy, personal bests, practice days.
// All pure; they read a store or its sessions and never change them.

import { sharpFlat } from '../score/format';
import { intervalKey, intervalName, intervalShort } from '../theory/intervals';
import { DEGREES } from '../theory/scales';
import type {
  CentsStat,
  Degree,
  Finding,
  RateStat,
  RegisterThird,
  ScaleMode,
  SkillsExerciseKind,
  SkillsMetric,
  SkillsSession,
  SkillsStats,
} from '../types';
import { degreeKey } from './stats';

// ---------------------------------------------------------------------------------------------
// Time series

export interface MetricInfo {
  label: string;
  /** What one value is: cents error, a 0..1 share, or seconds. */
  unit: 'cents' | 'share' | 'sec';
  better: 'lower' | 'higher';
  /** One sentence on what the line shows. */
  description: string;
}

export const METRIC_INFO: Readonly<Record<SkillsMetric, MetricInfo>> = Object.freeze({
  'pitch-mean-abs-cents': {
    label: 'Pitch test: average error',
    unit: 'cents',
    better: 'lower',
    description: 'How far your held notes were from the target on average, in cents (100 cents = 1 semitone). Lower is better.',
  },
  'ear-accuracy': { label: 'Interval ear training: correct', unit: 'share', better: 'higher', description: 'Share of intervals you named correctly in each session.' },
  'interval-abs-cents': {
    label: 'Sung intervals: size error',
    unit: 'cents',
    better: 'lower',
    description: 'How far the size of your sung intervals was from the asked size on average, in cents. Lower is better.',
  },
  'sequence-accuracy': { label: 'Scale-degree lines: notes in tune', unit: 'share', better: 'higher', description: 'Share of notes in your lines that were within your strictness band.' },
  'hiss-sec': { label: 'Hiss test: seconds', unit: 'sec', better: 'higher', description: 'How long one comfortable, steady "sss" lasted. Longer is not the only goal: steady matters more.' },
  'long-tone-sec': { label: 'Long tone: seconds', unit: 'sec', better: 'higher', description: 'How long you held one comfortable note at a steady volume.' },
});

export const SKILLS_METRICS: readonly SkillsMetric[] = Object.freeze(Object.keys(METRIC_INFO) as SkillsMetric[]);

const mean = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The value one session contributes to a series, or null when it has none (wrong kind, nothing scored). */
export function metricValue(s: SkillsSession, metric: SkillsMetric): number | null {
  switch (metric) {
    case 'pitch-mean-abs-cents':
      return s.kind === 'pitch-test' ? s.summary.meanAbsCents : null;
    case 'ear-accuracy':
      return s.kind === 'ear' && s.mode === 'interval' && s.total > 0 ? s.correct / s.total : null;
    case 'interval-abs-cents':
      if (s.kind !== 'sing-intervals') return null;
      return s.meanAbsIntervalCents ?? mean(s.items.flatMap((i) => (i.intervalCents === null ? [] : [Math.abs(i.intervalCents)])));
    case 'sequence-accuracy':
      return s.kind === 'sequence' ? mean(s.items.flatMap((i) => (i.status === 'ok' && i.noteAccuracy !== null ? [i.noteAccuracy] : []))) : null;
    case 'hiss-sec':
      return s.kind === 'breath' && s.hiss && s.hiss.status === 'ok' ? s.hiss.durationSec : null;
    case 'long-tone-sec':
      return s.kind === 'breath' && s.longTone && s.longTone.status === 'ok' ? s.longTone.durationSec : null;
  }
}

/** One point per session that has the measure, oldest first. Shares are 0..1, cents and seconds as measured. */
export function metricSeries(sessions: readonly SkillsSession[], metric: SkillsMetric): { at: string; value: number }[] {
  const out: { at: string; value: number; t: number; i: number }[] = [];
  sessions.forEach((s, i) => {
    const v = metricValue(s, metric);
    if (v !== null && Number.isFinite(v)) out.push({ at: s.at, value: v, t: Date.parse(s.at), i });
  });
  return out.sort((a, b) => a.t - b.t || a.i - b.i).map(({ at, value }) => ({ at, value }));
}

// ---------------------------------------------------------------------------------------------
// Headlines (hub cards, workout summary)

export interface SessionHeadline {
  /** The headline number in METRIC_INFO units, when the session has one. */
  metric: SkillsMetric | null;
  value: number | null;
  /** "12 cents off on average", "8 of 10 right" ... */
  text: string;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const secs = (x: number): string => `${x < 10 ? Math.round(x * 10) / 10 : Math.round(x)} s`;

/** A short plain summary of one session. */
export function sessionHeadline(s: SkillsSession): SessionHeadline {
  switch (s.kind) {
    case 'pitch-test': {
      const v = s.summary.meanAbsCents;
      return { metric: 'pitch-mean-abs-cents', value: v, text: v === null ? 'Not enough sound to score' : `${Math.round(v)} cents off on average` };
    }
    case 'match': {
      const locked = s.attempts.filter((a) => a.locked).length;
      return { metric: null, value: s.attempts.length ? locked / s.attempts.length : null, text: `Locked in on ${locked} of ${s.attempts.length} notes` };
    }
    case 'ear':
      return { metric: s.mode === 'interval' ? 'ear-accuracy' : null, value: s.total ? s.correct / s.total : null, text: `${s.correct} of ${s.total} right` };
    case 'sing-intervals': {
      const v = metricValue(s, 'interval-abs-cents');
      return { metric: 'interval-abs-cents', value: v, text: v === null ? 'Not enough sound to score' : `Interval size ${Math.round(v)} cents off on average` };
    }
    case 'sequence': {
      const v = metricValue(s, 'sequence-accuracy');
      return { metric: 'sequence-accuracy', value: v, text: v === null ? 'Not enough sound to score' : `${pct(v)} of notes in tune` };
    }
    case 'breath': {
      if (s.hiss && s.hiss.status === 'ok') return { metric: 'hiss-sec', value: s.hiss.durationSec, text: `Steady hiss for ${secs(s.hiss.durationSec)}` };
      if (s.longTone && s.longTone.status === 'ok') return { metric: 'long-tone-sec', value: s.longTone.durationSec, text: `Long tone held ${secs(s.longTone.durationSec)}` };
      if (s.paced) return { metric: null, value: s.paced.rounds, text: `${s.paced.rounds} paced ${s.paced.rounds === 1 ? 'round' : 'rounds'}, exhale up to ${s.paced.maxExhaleCounts} counts` };
      return { metric: null, value: null, text: 'Breathing practice' };
    }
    case 'workout':
      return { metric: null, value: s.totalSteps ? s.completedSteps / s.totalSteps : null, text: `${s.completedSteps} of ${s.totalSteps} steps done` };
  }
}

/** The newest session of a kind (workout steps included), or null. */
export function lastSessionOf<K extends SkillsExerciseKind>(sessions: readonly SkillsSession[], kind: K): Extract<SkillsSession, { kind: K }> | null {
  for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].kind === kind) return sessions[i] as Extract<SkillsSession, { kind: K }>;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tables

export interface IntervalRow {
  semitones: number;
  short: string;
  name: string;
  hearUp: RateStat | null;
  hearDown: RateStat | null;
  hearHarmonic: RateStat | null;
  /** Interval size error when sung (signed: + too wide). */
  singUp: CentsStat | null;
  singDown: CentsStat | null;
}

/** One row per interval (default 1..12, the simple intervals), with whatever has been measured. */
export function intervalTable(stats: SkillsStats, semitones: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]): IntervalRow[] {
  return semitones.map((s) => ({
    semitones: s,
    short: intervalShort(s),
    name: intervalName(s),
    hearUp: stats.hear[intervalKey(s, 'up')] ?? null,
    hearDown: stats.hear[intervalKey(s, 'down')] ?? null,
    hearHarmonic: stats.hear[intervalKey(s, 'harmonic')] ?? null,
    singUp: stats.sing[intervalKey(s, 'up')] ?? null,
    singDown: stats.sing[intervalKey(s, 'down')] ?? null,
  }));
}

export interface DegreeRow {
  degree: Degree;
  /** Notes measured (all time). */
  n: number;
  /** Recency-weighted average signed error, cents (+ sharp, - flat); null when unmeasured. */
  signedCents: number | null;
  absCents: number | null;
  /** Recency-weighted share named correctly in "Hear the degree"; null when unmeasured. */
  hearRate: number | null;
  hearN: number;
}

/** The per-degree tuning profile for one key mode (seven rows, degrees 1..7). */
export function degreeProfile(stats: SkillsStats, mode: ScaleMode): DegreeRow[] {
  return DEGREES.map((d) => {
    const c = stats.degrees[degreeKey(mode, d)];
    const h = stats.hearDegree[degreeKey(mode, d)];
    return { degree: d, n: c?.n ?? 0, signedCents: c ? c.emaSigned : null, absCents: c ? c.emaAbs : null, hearRate: h ? h.ema : null, hearN: h?.n ?? 0 };
  });
}

/** Signed error that counts as a habit, and how many notes it takes to say so. */
export const TENDENCY_CENTS = 10;
export const TENDENCY_MIN_NOTES = 5;

/**
 * "Your 7 tends to sit 20 cents flat, your 4 15 cents sharp": the clearest tendencies (at least 5 notes and 10 cents),
 * largest first, at most `max`. Empty when nothing stands out yet.
 */
export function degreeTendencies(stats: SkillsStats, mode: ScaleMode, max = 2): Finding[] {
  const rows = degreeProfile(stats, mode)
    .filter((r) => r.n >= TENDENCY_MIN_NOTES && r.signedCents !== null && Math.abs(r.signedCents) >= TENDENCY_CENTS)
    .sort((a, b) => Math.abs(b.signedCents as number) - Math.abs(a.signedCents as number))
    .slice(0, max);
  return rows.map((r) => ({ tone: 'work', text: `Your ${r.degree} tends to sit ${sharpFlat(r.signedCents as number)} (over ${r.n} notes).` }));
}

export interface RegisterRow {
  register: RegisterThird;
  n: number;
  signedCents: number | null;
  absCents: number | null;
}

/** Held-note tuning in the low, middle and high thirds of the comfortable range. */
export function registerTable(stats: SkillsStats): RegisterRow[] {
  return (['low', 'mid', 'high'] as RegisterThird[]).map((register) => {
    const c = stats.registers[register];
    return { register, n: c?.n ?? 0, signedCents: c ? c.emaSigned : null, absCents: c ? c.emaAbs : null };
  });
}

// ---------------------------------------------------------------------------------------------
// Practice days

/** Local calendar day "2026-10-18" of an ISO time. */
export function localDay(at: string | number | Date): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface PracticeDays {
  /** Distinct days with at least one session. */
  days: number;
  /** Consecutive days up to today, or up to yesterday when today has nothing yet (still alive). */
  streak: number;
  /** Sessions in the last 7 days, today included (workout wrappers not counted: their steps are). */
  last7: number;
  practisedToday: boolean;
}

export function practiceDays(sessions: readonly SkillsSession[], now: Date = new Date()): PracticeDays {
  const real = sessions.filter((s) => s.kind !== 'workout');
  const days = new Set(real.map((s) => localDay(s.at)));
  const today = localDay(now);
  const dayBefore = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12);
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  if (!days.has(today)) cursor = dayBefore(cursor);
  let streak = 0;
  while (days.has(localDay(cursor))) {
    streak++;
    cursor = dayBefore(cursor);
  }
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const last7 = real.filter((s) => {
    const t = Date.parse(s.at);
    return t >= weekStart && t <= now.getTime() + 60_000;
  }).length;
  return { days: days.size, streak, last7, practisedToday: days.has(today) };
}
