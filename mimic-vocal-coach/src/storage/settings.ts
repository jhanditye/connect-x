// App settings in localStorage under "mimic:v1:settings". Each field is validated on load and
// falls back to its default on its own, so one bad value never resets the rest. When storage is
// unavailable the settings live in memory for the page session.

import type { AppSettings, VoiceType } from '../types';
import { isRecord, readJson, writeJson } from './local';

export const SETTINGS_KEY = 'mimic:v1:settings';

// The literal (not an import of coach/ai.ts) keeps storage free of the AI SDK dependency.
export const DEFAULT_SETTINGS: AppSettings = Object.freeze<AppSettings>({
  voiceType: 'baritone',
  a4Hz: 440,
  anthropicApiKey: null,
  aiModel: 'claude-opus-5',
});

const VOICE_TYPES: ReadonlySet<string> = new Set<VoiceType>(['bass', 'baritone', 'tenor', 'alto', 'mezzo', 'soprano']);
// About a semitone either side of 440 Hz; beyond that "A4" would name a different note.
const A4_MIN = 415;
const A4_MAX = 466;

let memory: AppSettings | null = null;

/** Field-by-field validation of parsed JSON against the defaults. */
export function parseSettings(x: unknown): AppSettings {
  const src = isRecord(x) ? x : {};
  const voiceType = typeof src.voiceType === 'string' && VOICE_TYPES.has(src.voiceType) ? (src.voiceType as VoiceType) : DEFAULT_SETTINGS.voiceType;
  const a4 = src.a4Hz;
  const a4Hz = typeof a4 === 'number' && Number.isFinite(a4) && a4 >= A4_MIN && a4 <= A4_MAX ? a4 : DEFAULT_SETTINGS.a4Hz;
  const key = src.anthropicApiKey;
  const anthropicApiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
  const model = src.aiModel;
  const aiModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_SETTINGS.aiModel;
  return { voiceType, a4Hz, anthropicApiKey, aiModel };
}

export function loadSettings(): AppSettings {
  if (memory) return { ...memory };
  const read = readJson(SETTINGS_KEY);
  if (!read.available) {
    memory = { ...DEFAULT_SETTINGS };
    return { ...memory };
  }
  return parseSettings(read.value);
}

export function saveSettings(s: AppSettings): void {
  const clean = parseSettings(s);
  if (memory) {
    memory = clean;
    return;
  }
  if (!writeJson(SETTINGS_KEY, clean)) memory = clean;
}
