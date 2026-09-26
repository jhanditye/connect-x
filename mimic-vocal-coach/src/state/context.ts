// The app controller shape and its React context. Kept free of heavy imports so pages can be
// rendered in tests with a hand-built controller value.

import { createContext, useContext, type Dispatch } from 'react';
import type { AppSettings, SessionRecord, SingerProfile, VoiceType } from '../types';
import type { Action, AppState, TakeSource } from './reducer';
import type { Route } from './routing';
import type { ThemePref } from './theme';

export interface SamplesInput {
  samples: Float32Array;
  sampleRate: number;
  source: TakeSource;
  name: string;
}

export interface AppController {
  state: AppState;
  dispatch: Dispatch<Action>;
  /** The three builtin singers, in display order. */
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
  /** Saves the current result to history; returns the record or null when there is nothing to save. */
  saveSession(label?: string): SessionRecord | null;
  deleteSession(id: string): void;
  clearSessions(): void;
  clearAllData(): void;
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
