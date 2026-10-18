// The daily workout (about 10 minutes) and its end-of-workout summary (src/skills/SPEC.md section 5).
//
// Steps: paced breathing (2 rounds), match 6 notes, 10 ear questions on the weakest intervals of the singer's set
// (4 weakest + 2 easy), 4 sung intervals, 2 scale-degree lines biased to the weakest degrees, one hiss test.

import { sharpFlat } from '../score/format';
import { pacedBreathPlan, pacedPlanSeconds } from '../theory/breath';
import { cleanIntervalSet, earSetForLevel, intervalKey, intervalPhrase } from '../theory/intervals';
import { comfortableRange, fitSequence } from '../theory/range';
import { mixedLength, randomLine, SEQUENCE_PRESETS } from '../theory/generate';
import { shuffle, type Rng } from '../theory/rng';
import { parseSequence, sequenceText } from '../theory/sequence';
import type { AppSettings } from '../../types';
import type { Finding, IntervalDirection, SkillsPrefs, SkillsSession, SkillsStore, WorkoutSession, WorkoutStep } from '../types';
import { degreeTendencies, registerTable } from './history';
import { degreeWeights, intervalSetWeakness, intervalWeakness, weakestIntervals } from './stats';

/** "1 cent", "12 cents" (rounded). */
const centsCount = (c: number): string => {
  const a = Math.round(c);
  return `${a} ${Math.abs(a) === 1 ? 'cent' : 'cents'}`;
};

export const WORKOUT_PLAN = Object.freeze({
  pacedRounds: 2,
  matchNotes: 6,
  earQuestions: 10,
  earWeakest: 4,
  earEasy: 2,
  singIntervals: 4,
  sequences: 2,
});

/** Rough seconds per item, for the time estimate shown before starting (prompt + singing + feedback). */
const EST = { instructions: 15, matchNote: 18, earQuestion: 9, singInterval: 18, sequence: 45, hiss: 60 };

/** The interval set ear training uses with these preferences (semitones, ascending). */
export function currentEarSet(prefs: Pick<SkillsPrefs, 'earSetMode' | 'earLevel' | 'earCustom'>): number[] {
  return prefs.earSetMode === 'custom' ? cleanIntervalSet(prefs.earCustom) : earSetForLevel(prefs.earLevel);
}

/**
 * The workout's ear-training set: the whole current set when it has 6 intervals or fewer, otherwise its 4 weakest
 * (by recognition, over the singer's directions) plus 2 picked at random from the easier half of the rest.
 */
export function workoutEarSet(store: SkillsStore, rng: Rng): number[] {
  const set = currentEarSet(store.prefs);
  const { earWeakest, earEasy } = WORKOUT_PLAN;
  if (set.length <= earWeakest + earEasy) return set.slice();
  const dirs = store.prefs.earDirections;
  const ranked = shuffle(rng, set)
    .map((s) => ({ s, w: intervalSetWeakness(store.stats, s, dirs, 'hear') }))
    .sort((a, b) => b.w - a.w);
  const weak = ranked.slice(0, earWeakest).map((r) => r.s);
  const rest = ranked.slice(earWeakest);
  const easierHalf = rest.slice(Math.floor(rest.length / 2));
  const easy = shuffle(rng, easierHalf.length >= earEasy ? easierHalf : rest)
    .slice(0, earEasy)
    .map((r) => r.s);
  return [...weak, ...easy].sort((a, b) => a - b);
}

/**
 * `count` different scale-degree lines (4 to 7 notes) biased towards the singer's weakest degrees, as sequence text
 * that parses back to the same notes and fits the singer's comfortable range.
 */
export function workoutSequenceTexts(store: SkillsStore, settings: Pick<AppSettings, 'voiceType'>, rng: Rng, count: number = WORKOUT_PLAN.sequences): string[] {
  const mode = store.prefs.scaleMode;
  const range = comfortableRange(settings.voiceType, store.prefs.rangeOverride);
  const weights = degreeWeights(store.stats, mode);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text: string | null = null;
    for (let attempt = 0; attempt < 25 && text === null; attempt++) {
      const notes = randomLine(rng, Math.min(7, mixedLength(rng)), mode, { degreeWeights: weights });
      const t = sequenceText(notes);
      const back = parseSequence(t, mode);
      const same = back.ok && back.notes.length === notes.length && back.notes.every((n, k) => n.semitones === notes[k].semitones);
      if (same && !out.includes(t) && fitSequence(notes, mode, range) !== null) text = t;
    }
    out.push(text ?? SEQUENCE_PRESETS[i % SEQUENCE_PRESETS.length].text);
  }
  return out;
}

/** Today's workout steps, in order. Seeded: the same rng stream gives the same workout. */
export function buildWorkout(store: SkillsStore, settings: AppSettings, rng: Rng): WorkoutStep[] {
  const p = WORKOUT_PLAN;
  const paced = pacedBreathPlan({ rounds: p.pacedRounds });
  return [
    {
      kind: 'breath',
      label: `Breathing: ${p.pacedRounds} slow rounds`,
      estSec: Math.round(pacedPlanSeconds(paced) + EST.instructions),
      plan: { parts: ['paced'], pacedRounds: p.pacedRounds },
    },
    { kind: 'match', label: `Match ${p.matchNotes} notes`, estSec: p.matchNotes * EST.matchNote, plan: { count: p.matchNotes } },
    {
      kind: 'ear',
      label: `Name ${p.earQuestions} intervals`,
      estSec: p.earQuestions * EST.earQuestion,
      plan: { mode: 'interval', questions: p.earQuestions, set: workoutEarSet(store, rng) },
    },
    { kind: 'sing-intervals', label: `Sing ${p.singIntervals} intervals`, estSec: p.singIntervals * EST.singInterval, plan: { count: p.singIntervals, mode: 'read' } },
    {
      kind: 'sequence',
      label: `Sing ${p.sequences} scale-degree lines`,
      estSec: p.sequences * EST.sequence,
      plan: { texts: workoutSequenceTexts(store, settings, rng, p.sequences), mode: 'read' },
    },
    { kind: 'breath', label: 'Hiss test', estSec: EST.hiss, plan: { parts: ['hiss'] } },
  ];
}

export function workoutSeconds(steps: readonly WorkoutStep[]): number {
  return steps.reduce((s, x) => s + x.estSec, 0);
}

// ---------------------------------------------------------------------------------------------
// End-of-workout summary

interface Comparable {
  /** Groups sessions that can be compared ("match", "hiss" ...). */
  key: string;
  label: string;
  value: number;
  unit: 'cents' | 'share' | 'sec';
  better: 'lower' | 'higher';
}

const meanOf = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The numbers of a session that can be compared with an earlier one of the same kind. */
function comparables(s: SkillsSession): Comparable[] {
  const out: Comparable[] = [];
  const push = (key: string, label: string, value: number | null, unit: Comparable['unit'], better: Comparable['better']) => {
    if (value !== null && Number.isFinite(value)) out.push({ key, label, value, unit, better });
  };
  switch (s.kind) {
    case 'pitch-test':
      push('pitch-test', 'Pitch test', s.summary.meanAbsCents, 'cents', 'lower');
      break;
    case 'match':
      push('match', 'Matching notes', meanOf(s.attempts.flatMap((a) => (a.heldCents === null ? [] : [Math.abs(a.heldCents)]))), 'cents', 'lower');
      break;
    case 'ear':
      if (s.mode === 'interval' && s.total > 0) push('ear', 'Naming intervals', s.correct / s.total, 'share', 'higher');
      break;
    case 'sing-intervals':
      push('sing-intervals', 'Singing intervals', s.meanAbsIntervalCents ?? meanOf(s.items.flatMap((i) => (i.intervalCents === null ? [] : [Math.abs(i.intervalCents)]))), 'cents', 'lower');
      break;
    case 'sequence':
      push('sequence', 'Scale-degree lines', meanOf(s.items.flatMap((i) => (i.status === 'ok' && i.noteAccuracy !== null ? [i.noteAccuracy] : []))), 'share', 'higher');
      break;
    case 'breath':
      if (s.hiss && s.hiss.status === 'ok') push('hiss', 'Hiss test', s.hiss.durationSec, 'sec', 'higher');
      if (s.longTone && s.longTone.status === 'ok') push('long-tone', 'Long tone', s.longTone.durationSec, 'sec', 'higher');
      break;
    case 'workout':
      break;
  }
  return out;
}

function fmt(v: number, unit: Comparable['unit']): string {
  if (unit === 'cents') return `${centsCount(v)} off on average`;
  if (unit === 'share') return `${Math.round(v * 100)}% right`;
  return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} s`;
}

function fmtShort(v: number, unit: Comparable['unit']): string {
  if (unit === 'cents') return `${centsCount(v)}`;
  if (unit === 'share') return `${Math.round(v * 100)}%`;
  return fmt(v, unit);
}

/** Smallest change that counts as better or worse rather than day-to-day noise. */
function meaningful(c: Comparable, prev: number): number {
  if (c.unit === 'cents') return Math.max(5, 0.15 * prev);
  if (c.unit === 'share') return 0.1;
  return Math.max(2, 0.1 * prev);
}

/**
 * Plain findings for the end of a workout: what improved or held steady against the previous session of the same
 * kind (outside this workout), then one or two things to work on next. At most 5; never "you failed".
 */
export function workoutFindings(store: SkillsStore, workout: WorkoutSession): Finding[] {
  const ids = new Set(workout.partIds);
  const parts = store.sessions.filter((s) => ids.has(s.id) || (s.workoutId !== undefined && s.workoutId === workout.id));
  const partIds = new Set(parts.map((s) => s.id));
  const progress: Finding[] = [];
  const first: Finding[] = [];
  const seenKeys = new Set<string>();
  for (const part of parts) {
    for (const c of comparables(part)) {
      if (seenKeys.has(c.key)) continue;
      seenKeys.add(c.key);
      const t = Date.parse(part.at);
      let prev: Comparable | null = null;
      for (let i = store.sessions.length - 1; i >= 0 && !prev; i--) {
        const s = store.sessions[i];
        if (partIds.has(s.id) || Date.parse(s.at) >= t) continue;
        prev = comparables(s).find((x) => x.key === c.key) ?? null;
      }
      if (!prev) {
        first.push({ tone: 'info', text: `${c.label}: ${fmt(c.value, c.unit)}. That is your first measure to beat.` });
        continue;
      }
      const delta = c.value - prev.value;
      const gain = c.better === 'lower' ? -delta : delta;
      const step = meaningful(c, prev.value);
      if (gain >= step) {
        progress.push({ tone: 'good', text: `${c.label} improved: ${fmt(c.value, c.unit)}, ${c.better === 'lower' ? 'down' : 'up'} from ${fmtShort(prev.value, c.unit)} last time.` });
      } else if (gain <= -step) {
        progress.push({ tone: 'info', text: `${c.label}: ${fmt(c.value, c.unit)} today, ${fmtShort(prev.value, c.unit)} last time. Ups and downs from day to day are normal.` });
      } else {
        progress.push({ tone: 'info', text: `${c.label} held steady: ${fmt(c.value, c.unit)} (${fmtShort(prev.value, c.unit)} last time).` });
      }
    }
  }
  progress.sort((a, b) => (a.tone === 'good' ? 0 : 1) - (b.tone === 'good' ? 0 : 1));

  const next: Finding[] = [];
  const dirs: IntervalDirection[] = store.prefs.earDirections.slice();
  const among = currentEarSet(store.prefs).flatMap((s) => dirs.map((direction) => ({ semitones: s, direction })));
  const weakHear = weakestIntervals(store.stats, 1, 'hear', among).find((c) => {
    const st = store.stats.hear[intervalKey(c.semitones, c.direction)];
    return st !== undefined && st.n >= 3 && intervalWeakness(store.stats, c.semitones, c.direction, 'hear') >= 0.3;
  });
  if (weakHear) {
    const rate = 1 - intervalWeakness(store.stats, weakHear.semitones, weakHear.direction, 'hear');
    const how = rate >= 0.05 ? `about ${Math.round(rate * 100)}% right lately` : 'still a tricky one';
    next.push({ tone: 'work', text: `Next to work on: hearing ${intervalPhrase(weakHear.semitones, weakHear.direction)} (${how}).` });
  }
  const tendency = degreeTendencies(store.stats, store.prefs.scaleMode, 1)[0];
  if (tendency) next.push(tendency);
  if (next.length < 2) {
    const reg = registerTable(store.stats)
      .filter((r) => r.n >= 5 && r.signedCents !== null && Math.abs(r.signedCents) >= 15)
      .sort((a, b) => Math.abs(b.signedCents as number) - Math.abs(a.signedCents as number))[0];
    if (reg) next.push({ tone: 'work', text: `Your ${reg.register === 'mid' ? 'middle' : reg.register} notes tend to sit ${sharpFlat(reg.signedCents as number)}.` });
  }

  const head = [...progress, ...first].slice(0, 5 - Math.min(2, next.length));
  const out = [...head, ...next.slice(0, 2)];
  if (out.length === 0) out.push({ tone: 'good', text: 'Workout done. Come back tomorrow: a little every day beats a lot once a week.' });
  return out;
}
