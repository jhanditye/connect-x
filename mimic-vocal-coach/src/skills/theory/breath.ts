// Paced breathing plan and the breath safety notes every breath screen shows.

import type { PacedBreathRound } from '../types';

export interface PacedBreathOptions {
  rounds: number;
  inhale: number;
  suspend: number;
  startExhale: number;
  exhaleStep: number;
  exhaleCap: number;
}

export const BREATH_DEFAULTS: Readonly<PacedBreathOptions & { countSec: number }> = Object.freeze({
  rounds: 5,
  inhale: 4,
  suspend: 4,
  startExhale: 8,
  exhaleStep: 2,
  exhaleCap: 20,
  /** One count, seconds. */
  countSec: 1,
});

/**
 * Rounds of inhale / suspend / exhale counts; the exhale grows by `exhaleStep` each round up to `exhaleCap`
 * (defaults: 8, 10, 12, 14, 16).
 */
export function pacedBreathPlan(opts: Partial<PacedBreathOptions> = {}): PacedBreathRound[] {
  const o = { ...BREATH_DEFAULTS, ...opts };
  const rounds = Math.max(1, Math.min(12, Math.round(o.rounds)));
  const out: PacedBreathRound[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push({ inhale: o.inhale, suspend: o.suspend, exhale: Math.min(o.exhaleCap, o.startExhale + i * o.exhaleStep) });
  }
  return out;
}

/** Seconds a plan takes at `countSec` per count, plus `restSec` of normal breathing between rounds. */
export function pacedPlanSeconds(plan: readonly PacedBreathRound[], countSec: number = BREATH_DEFAULTS.countSec, restSec = 4): number {
  let s = 0;
  plan.forEach((r, i) => {
    s += (r.inhale + r.suspend + r.exhale) * countSec;
    if (i < plan.length - 1) s += restSec;
  });
  return s;
}

/** Shown on every breath screen (and in the Guide). Plain, short, not medical advice. */
export const BREATH_SAFETY_NOTES: readonly string[] = Object.freeze([
  'Stop and breathe normally if you feel dizzy or light-headed.',
  'Breathe normally between rounds.',
  'Never squeeze out the very last air: stop while it still feels easy.',
  'Keep the throat open and relaxed: the "suspend" is a gentle pause, not a held or locked throat.',
  'This is practice guidance, not medical advice. If you have a breathing or heart condition, check with your doctor first.',
]);
