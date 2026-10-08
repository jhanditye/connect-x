// The app controller shape and its React context. Kept free of heavy imports so pages can be
// rendered in tests with a hand-built controller value.

import { createContext, useContext, type Dispatch } from 'react';
import type { AppSettings, MeasuredClip, SessionRecord, SingerProfile, VoiceType } from '../types';
import type { Action, AppState, TakeSource } from './reducer';
import type { Route } from './routing';
import type { ThemePref } from './theme';

export interface SamplesInput {
  samples: Float32Array;
  sampleRate: number;
  source: TakeSource;
  name: string;
  /** Length of the original file when decoding already cut it short, s. */
  sourceDurationSec?: number;
  /** Notes from decoding (e.g. stereo channels that cancel out), shown with the results. */
  notices?: string[];
}

/** Progress of measuring a batch of artist clips (one file at a time). */
export interface MeasureProgress {
  index: number;
  count: number;
  name: string;
  phase: 'decoding' | 'analyzing';
  /** 0..1 within the current file. */
  fraction: number;
}

export interface MeasureResult {
  /** Clips that were measured and kept. */
  added: number;
  /** Files that could not be used, with the reason in plain English. */
  rejected: { name: string; reason: string }[];
}

export interface AppController {
  state: AppState;
  dispatch: Dispatch<Action>;
  /** The three builtin singers, in display order (with measured targets where the user added clips). */
  builtins: SingerProfile[];
  /** Builtins plus the reference profile when a reference clip is loaded. */
  profiles: SingerProfile[];
  /** The selected profile (null only if no profiles are available at all). */
  profile: SingerProfile | null;
  route: Route;
  go(route: Route): void;
  /** Analyse a take. Resolves true on success (errors land in state.error). */
  analyzeSamples(input: SamplesInput): Promise<boolean>;
  analyzeFile(file: File): Promise<boolean>;
  analyzeDemo(): Promise<boolean>;
  loadReferenceFile(file: File): Promise<boolean>;
  setReferenceVoiceType(v: VoiceType | null): void;
  clearReference(): void;
  selectProfile(id: string): void;
  updateSettings(patch: Partial<AppSettings>): void;
  /**
   * Saves the current result to history; returns the record, or null when there is nothing to save,
   * the take cannot be scored, or this take and target were already saved.
   */
  saveSession(label?: string): SessionRecord | null;
  deleteSession(id: string): void;
  clearSessions(): void;
  clearAllData(): void;
  /** Measures clips of a builtin singer from the user's own music; their targets replace the estimates. */
  measureClips(singerId: string, files: File[], onProgress?: (p: MeasureProgress) => void): Promise<MeasureResult>;
  /**
   * Adds one already-measured clip to a builtin singer's targets (the trainer's "use for this singer's targets").
   * A clip with the same id replaces the old entry; only the newest MAX_CLIPS_PER_SINGER are kept.
   */
  addMeasuredClip(singerId: string, clip: MeasuredClip): void;
  removeMeasuredClip(singerId: string, clipId: string): void;
  /** Removes every measured clip of a singer, going back to the estimated targets. */
  clearMeasuredClips(singerId: string): void;
  openPractice(exerciseIds?: string[]): void;
  recordDrill(exerciseId: string): void;
  theme: ThemePref;
  setTheme(t: ThemePref): void;
}

export const AppContext = createContext<AppController | null>(null);

export function useApp(): AppController {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>.');
  return ctx;
}
