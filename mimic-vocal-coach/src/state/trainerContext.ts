// The trainer controller shape and its React context. Kept free of heavy imports (like state/context.ts) so screens can
// be rendered in tests with a hand-built or fake controller value (see testing/trainerFixtures.ts).

import { createContext, useContext } from 'react';
import type { StorageStatus } from '../storage/quota';
import type { ImportProgress, CommitEdits, PreparedClip } from '../trainer/import';
import type { PracticeEngine } from '../trainer/engine';
import type { QueueItem } from '../trainer/srs';
import type { AttemptRecord, ClipRecord, PhraseRecord, SingerProfile } from '../types';

/** What the last exportLibrary left out, so a screen can say so instead of calling a partial file "a backup". */
export interface ExportReport {
  /** Everything that could be read was read. False: the file is partial and the backup reminder was NOT cleared. */
  complete: boolean;
  /** Plain sentences about what is missing (practice history that could not be read, clips the app cannot open...). */
  warnings: string[];
  clips: number;
  attempts: number;
}

export interface TrainerController {
  /** 'memory-only': IndexedDB is unavailable, clips are lost when the app closes (show the banner). */
  status: 'loading' | 'ready' | 'memory-only' | 'error';
  error: string | null;
  clips: ClipRecord[];
  storage: StorageStatus;
  singers: SingerProfile[];
  /** Today's practice list across all clips (srs.ts practiceQueue), at most five. */
  queue: QueueItem[];
  getClip(id: string): ClipRecord | undefined;
  updateClip(id: string, patch: Partial<Pick<ClipRecord, 'title' | 'singerId' | 'singerLabel' | 'notes' | 'tags' | 'difficulty'>>): Promise<void>;
  updatePhrases(clipId: string, phrases: PhraseRecord[]): Promise<void>;
  deleteClip(id: string): Promise<void>;
  /** Adds or removes the clip's measurements from its singer's targets (AppController.addMeasuredClip / removeMeasuredClip). */
  setContributes(clipId: string, on: boolean): Promise<void>;
  /**
   * The library as a backup file (JSON, never audio). By default it also counts as "backed up" (the reminder resets) as soon as the
   * Blob is built; pass `markDone: false` and call `markExported` once the file has really been saved, so a cancelled or failed
   * save does not silence the reminder.
   */
  exportLibrary(options?: { markDone?: boolean }): Promise<Blob>;
  /** Records that the last exportLibrary({ markDone: false }) file was saved. Optional: controllers without a reminder omit it. */
  markExported?(exportedAt?: string): Promise<void>;
  /** What the most recent exportLibrary included and left out (null before the first). Optional. */
  lastExportReport?(): ExportReport | null;
  importLibrary(file: File): Promise<{ added: number; updated: number; warnings: string[] }>;
  /**
   * Decode, analyse and segment one file. Nothing is stored until commitClip. Rejects with a message that names the fix. `signal`
   * cancels: the analysis worker is stopped and the promise rejects with an AbortError (nothing to show for it).
   */
  prepareClip(file: File, onProgress?: (p: ImportProgress) => void, signal?: AbortSignal): Promise<PreparedClip>;
  commitClip(prepared: PreparedClip, edits: CommitEdits, onProgress?: (p: ImportProgress) => void): Promise<ClipRecord>;
  /**
   * The stored audio of a clip as mono float samples (the vocal-only file when the clip has one, else the song), for the phrase editor's
   * waveform. null when the clip has no audio on this device. Optional: controllers without it get an editor with no waveform.
   */
  readClipSamples?(clipId: string): Promise<{ samples: Float32Array; sampleRate: number; source: 'mix' | 'vocal' } | null>;
  /** Re-attaches the audio of a clip whose audio is missing (after a library import). */
  relinkClip(clipId: string, prepared: PreparedClip): Promise<ClipRecord>;
  /** Newest first. */
  listAttempts(filter: { phraseId?: string; clipId?: string; limit?: number }): Promise<AttemptRecord[]>;
  deleteAttempts(filter: { phraseId?: string; clipId?: string }): Promise<number>;
  /** Opens one phrase for practice. The caller disposes the engine when the screen closes. */
  openPractice(clipId: string, phraseId: string): Promise<PracticeEngine>;
  /** Deletes every clip, attempt and recording (called from Settings "Delete everything"). */
  clearAll(): Promise<void>;
}

export const TrainerContext = createContext<TrainerController | null>(null);

export function useTrainer(): TrainerController {
  const ctx = useContext(TrainerContext);
  if (!ctx) throw new Error('useTrainer must be used inside <TrainerProvider>.');
  return ctx;
}
