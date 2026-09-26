// Register-share helpers for the Results page.

import type { SingerProfile, VoiceAnalysis } from '../../types';

export type Shares = { chest: number; mix: number; head: number };

/** Target register shares for the upper range when the profile sets at least two of them (the third is the remainder). */
export function registerTarget(profile: SingerProfile): Shares | undefined {
  const t = profile.targets;
  const c = t.chestInUpperRange?.ideal;
  const m = t.mixInUpperRange?.ideal;
  const h = t.headInUpperRange?.ideal;
  const known = [c, m, h].filter((v): v is number => v !== undefined);
  if (known.length < 2) return undefined;
  const rest = Math.max(0, 1 - known.reduce((a, b) => a + b, 0));
  const raw = { chest: c ?? rest, mix: m ?? rest, head: h ?? rest };
  const sum = raw.chest + raw.mix + raw.head;
  return sum > 0 ? { chest: raw.chest / sum, mix: raw.mix / sum, head: raw.head / sum } : undefined;
}

/** The user's upper-range register shares, or undefined when the take never reached the passaggio. */
export function userUpperShares(analysis: VoiceAnalysis): Shares | undefined {
  const s = analysis.style;
  if (s.chestInUpperRange === null || s.mixInUpperRange === null || s.headInUpperRange === null) return undefined;
  return { chest: s.chestInUpperRange, mix: s.mixInUpperRange, head: s.headInUpperRange };
}

