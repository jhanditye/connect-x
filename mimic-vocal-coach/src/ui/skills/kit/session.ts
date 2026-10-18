// Small shared helpers for the Skills shell screens (hub, ear training, workout, progress): the common session fields,
// the comfortable range for these settings, and plain number formatting.

import { skillsId } from '../../../skills/progress/store';
import { comfortableRange } from '../../../skills/theory/range';
import type { AppSettings } from '../../../types';
import type { SkillsPrefs, Strictness, VoiceRange } from '../../../skills/types';

export interface SessionBaseFields {
  id: string;
  at: string;
  durationSec: number;
  strictness: Strictness;
  voiceType: AppSettings['voiceType'];
  a4Hz: number;
}

/** The fields every Skills session carries, for a session that started at `startedMs` (Date.now()) and ends now. */
export function sessionBase(settings: AppSettings, prefs: Pick<SkillsPrefs, 'strictness'>, startedMs: number, nowMs: number = Date.now()): SessionBaseFields {
  return {
    id: skillsId(),
    at: new Date(nowMs).toISOString(),
    durationSec: Math.max(0, Math.round((nowMs - startedMs) / 100) / 10),
    strictness: prefs.strictness,
    voiceType: settings.voiceType,
    a4Hz: settings.a4Hz,
  };
}

/** The singer's comfortable range: the override from the Skills preferences, else the voice type's. */
export function rangeFor(settings: Pick<AppSettings, 'voiceType'>, prefs: Pick<SkillsPrefs, 'rangeOverride'>): VoiceRange {
  return comfortableRange(settings.voiceType, prefs.rangeOverride);
}

/** "80%" from a 0..1 share. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** "about 8 minutes" / "about 1 minute" / "under a minute". */
export function aboutMinutes(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 1) return 'under a minute';
  return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** "3 of 10" style plural helper: plural(2, 'note') -> "2 notes". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
