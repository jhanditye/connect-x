import type { NoteSegment } from '../../types';
import type { Alignment } from './align';
import type { Prep } from './contour';
import type { NoteScore, ScoreComponent, SkillKey } from './types';

export interface Ctx {
  ref: Prep;
  att: Prep;
  al: Alignment;
  mode: 'sing-along' | 'turn-taking';
  keyMode: 'free' | 'locked';
  rate: number;
  speech: boolean;
  perNote: NoteScore[];
  /** Per reference note: ornament / run note. */
  ornament: boolean[];
  toneBias: Partial<Record<'breathiness' | 'brightness' | 'rasp', number>>;
}

/** Mapped attempt window of reference note k, null when the note was not matched. */
export function win(ctx: Ctx, k: number): { u0: number; u1: number } | null {
  const nm = ctx.al.notes[k];
  return nm.matched && Number.isFinite(nm.u0) && Number.isFinite(nm.u1) && nm.u1 > nm.u0 ? { u0: nm.u0, u1: nm.u1 } : null;
}

/** The attempt's own note that best covers reference note k's mapped window (>= half of the window), or null. */
export function userNoteFor(ctx: Ctx, k: number): NoteSegment | null {
  const w = win(ctx, k);
  if (!w) return null;
  let best: NoteSegment | null = null;
  let bestOv = 0;
  for (const n of ctx.att.a.notes) {
    const ov = Math.min(n.end, w.u1) - Math.max(n.start, w.u0);
    if (ov > bestOv) {
      bestOv = ov;
      best = n;
    }
  }
  return best && bestOv >= 0.5 * (w.u1 - w.u0) ? best : null;
}

/** A finding that may become a fix. `lossSkill` is the number of points (0..100 scale) of its skill score it costs. */
export interface Insight {
  id: string;
  skill: SkillKey;
  kind: 'fix' | 'info' | 'good';
  title: string;
  text: string;
  advice: string;
  lossSkill: number;
  notes: number[];
}

export interface SkillResult {
  score: number | null;
  components: ScoreComponent[];
  insights: Insight[];
  stats: Record<string, number | string | boolean | null>;
}

/** Weighted average of the components that have a score (weights re-normalised). */
export function combine(components: ScoreComponent[]): number | null {
  let w = 0;
  let s = 0;
  for (const c of components) {
    if (c.score === null || !Number.isFinite(c.score)) continue;
    w += c.weight;
    s += c.weight * c.score;
  }
  return w > 0 ? s / w : null;
}

/** Skill points a component costs: its share of the skill average times its shortfall. */
export function componentLoss(components: ScoreComponent[], id: string): number {
  const total = components.reduce((a, c) => a + (c.score !== null ? c.weight : 0), 0);
  const c = components.find((x) => x.id === id);
  if (!c || c.score === null || total <= 0) return 0;
  return (c.weight / total) * (100 - c.score);
}
