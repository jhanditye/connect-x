// Small per-device preferences for the Trainer (default speed, count-in, how a practice visit starts, whether to keep the
// recording of each take). Kept in this browser's local storage under their own key so AppSettings keeps its shape. Numbers and
// switches only; nothing here is audio. The practice engine factory reads `loadTrainerPrefs()` when it opens a phrase.

import { useCallback, useEffect, useState } from 'react';
import { readJson, writeJson, isRecord } from '../storage/local';

const KEY = 'mimic.trainerPrefs';
const EVENT = 'mimic-trainer-prefs';

/** The speeds the practice screen offers (1 = the original). 0.5 is offered but flagged as rough. */
export const SPEEDS: readonly number[] = [1, 0.9, 0.75, 0.6, 0.5];
export const COUNT_IN_CHOICES: readonly number[] = [2, 3, 4];

export type StartMode = 'auto' | 'sing-along' | 'turn-taking';

export interface TrainerPrefs {
  /** Speed a phrase opens at when it has no speed of its own yet. */
  defaultRate: number;
  countInBeats: number;
  /** 'auto': sing along when headphones are likely, otherwise listen first and then sing. */
  startMode: StartMode;
  /** Keep the last three takes of each phrase on this device so they can be played back. */
  keepRecordings: boolean;
}

export const DEFAULT_TRAINER_PREFS: TrainerPrefs = { defaultRate: 1, countInBeats: 3, startMode: 'auto', keepRecordings: false };

function nearest(value: unknown, choices: readonly number[], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return choices.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best), choices[0]);
}

/** Reads one stored value defensively: anything unexpected falls back to the default. */
export function parseTrainerPrefs(x: unknown): TrainerPrefs {
  const d = DEFAULT_TRAINER_PREFS;
  if (!isRecord(x)) return { ...d };
  return {
    defaultRate: nearest(x.defaultRate, SPEEDS, d.defaultRate),
    countInBeats: nearest(x.countInBeats, COUNT_IN_CHOICES, d.countInBeats),
    startMode: x.startMode === 'sing-along' || x.startMode === 'turn-taking' ? x.startMode : 'auto',
    keepRecordings: x.keepRecordings === true,
  };
}

export function loadTrainerPrefs(): TrainerPrefs {
  const r = readJson(KEY);
  return r.available ? parseTrainerPrefs(r.value) : { ...DEFAULT_TRAINER_PREFS };
}

/** Merges the change into what is stored and tells other screens in this tab. Returns the new preferences (kept in memory if storage is blocked). */
export function saveTrainerPrefs(patch: Partial<TrainerPrefs>): TrainerPrefs {
  const next = parseTrainerPrefs({ ...loadTrainerPrefs(), ...patch });
  writeJson(KEY, next);
  try {
    window.dispatchEvent(new CustomEvent<TrainerPrefs>(EVENT, { detail: next }));
  } catch {
    // No window (server rendering): nothing is listening.
  }
  return next;
}

/** Preferences as React state; changes made on any screen show up everywhere. */
export function useTrainerPrefs(): [TrainerPrefs, (patch: Partial<TrainerPrefs>) => void] {
  const [prefs, setPrefs] = useState<TrainerPrefs>(loadTrainerPrefs);
  useEffect(() => {
    const onChange = (e: Event) => setPrefs((e as CustomEvent<TrainerPrefs>).detail ?? loadTrainerPrefs());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  const update = useCallback((patch: Partial<TrainerPrefs>) => setPrefs(saveTrainerPrefs(patch)), []);
  return [prefs, update];
}
