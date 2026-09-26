// Measured singer clips in localStorage under "mimic:v1:measurements": for each builtin singer id,
// the measurements of the clips of that singer the user added (numbers only, never audio). Parsed
// field by field; malformed entries are dropped. When storage is unavailable the data lives in
// memory for the page session.

import type { MeasuredClip } from '../types';
import { sanitizeStyle } from './history';
import { isRecord, readJson, removeKey, writeJson } from './local';

export const MEASUREMENTS_KEY = 'mimic:v1:measurements';

export type Measurements = Record<string, MeasuredClip[]>;

let memory: Measurements | null = null;

function finite(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function midiOrNull(x: unknown): number | null {
  return finite(x) ? x : null;
}

export function parseMeasuredClip(x: unknown): MeasuredClip | null {
  if (!isRecord(x)) return null;
  const { id, name, addedAt, durationSec, voicedSec } = x;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof addedAt !== 'string') return null;
  if (!finite(durationSec) || !finite(voicedSec)) return null;
  const pitch = isRecord(x.pitch) ? x.pitch : {};
  return {
    id,
    name,
    addedAt,
    durationSec,
    voicedSec,
    style: sanitizeStyle(x.style),
    pitch: {
      lowMidi: midiOrNull(pitch.lowMidi),
      highMidi: midiOrNull(pitch.highMidi),
      tessituraLowMidi: midiOrNull(pitch.tessituraLowMidi),
      tessituraHighMidi: midiOrNull(pitch.tessituraHighMidi),
    },
  };
}

export function parseMeasurements(x: unknown): Measurements {
  const out: Measurements = {};
  if (!isRecord(x)) return out;
  for (const [singerId, list] of Object.entries(x)) {
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const clips: MeasuredClip[] = [];
    for (const item of list) {
      const clip = parseMeasuredClip(item);
      if (clip && !seen.has(clip.id)) {
        seen.add(clip.id);
        clips.push(clip);
      }
    }
    if (clips.length) out[singerId] = clips;
  }
  return out;
}

export function loadMeasurements(): Measurements {
  if (memory) return { ...memory };
  const read = readJson(MEASUREMENTS_KEY);
  if (!read.available) {
    memory = {};
    return {};
  }
  return parseMeasurements(read.value);
}

export function saveMeasurements(m: Measurements): void {
  const clean = parseMeasurements(m);
  if (memory) {
    memory = clean;
    return;
  }
  if (!writeJson(MEASUREMENTS_KEY, clean)) memory = clean;
}

export function clearMeasurements(): void {
  if (memory) {
    memory = {};
    return;
  }
  removeKey(MEASUREMENTS_KEY);
}
