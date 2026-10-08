// The practice-loop contract between the practice screen and the audio / compare modules: one PracticeEngine per open
// phrase. Screens code against this interface (useSyncExternalStore-compatible); testing/trainerFixtures.ts has a
// scripted FakeTrainerEngine. The real engine (W3 audio + W4 compare) wires duplex.ts, player.ts, phraseAnalysis.ts,
// compare.ts, feedback.ts and srs.ts behind it. Types only: no runtime code here.

import type { RouteInfo } from '../audio/duplex';
import type { AttemptRecord, ClipRecord, KeyMode, PhraseComparison, PhraseRecord, PlayMode, VoiceAnalysis } from '../types';
import type { TrainerFix } from './feedback';

/**
 * preparing  loading the phrase audio and the reference analysis (and the slow / transposed guide)
 * idle       ready; Listen and Sing are enabled
 * listening  the guide is playing
 * countin    count-in clicks before a take (`countIn` = beats left)
 * singing    recording; live pitch is available
 * processing analysing and comparing the take
 * result     `result` is set; Try again keeps the microphone open
 * interrupted the take or the playback was cut short (phone call, app hidden, microphone ended, route change); `message` says what to do
 * error      something failed; `message` names the next step
 * closed     disposed
 */
export type PracticeState = 'preparing' | 'idle' | 'listening' | 'countin' | 'singing' | 'processing' | 'result' | 'interrupted' | 'error' | 'closed';

export interface PracticeOptions {
  /** Playback speed of the guide, 0.5..1. */
  rate: number;
  /** Guide transposition in semitones (0 = original key). Locked key mode applies when the guide is audible. */
  guideShift: number;
  mode: PlayMode;
  /** Count-in beats, 2..4. */
  countInBeats: number;
  /** Loop region in phrase seconds, or null for the whole phrase. */
  loop: { from: number; to: number } | null;
}

export interface PracticeResult {
  comparison: PhraseComparison;
  /** At most three, ranked (feedback.ts buildFixes). */
  fixes: TrainerFix[];
  /** The attempt as stored (or as it would have been stored when `saved` is false). */
  attempt: AttemptRecord;
  saved: boolean;
  /** Why the attempt was not saved or should be doubted (speaker bleed, unclear key); names the next step. null when fine. */
  notice: string | null;
  keyMode: KeyMode;
}

export interface PracticeSnapshot {
  state: PracticeState;
  /** Shown under the controls for interrupted / error / hints; always names the next step. */
  message: string | null;
  route: RouteInfo | null;
  options: PracticeOptions;
  /** Beats left in the count-in. */
  countIn: number | null;
  /** Live pitch while singing, in the reference's displayed key (fractional MIDI); null when unvoiced. */
  liveMidi: number | null;
  /** Input level 0..1 while singing. */
  level: number;
  /** The reference phrase analysis (notes and contour for the strip); null while preparing. */
  reference: VoiceAnalysis | null;
  result: PracticeResult | null;
  /** The microphone is open right now (it stays open for a short while after a take so Try again is instant). Absent = unknown / false. */
  micOpen?: boolean;
  /** The singer has confirmed sing-along without headphones for this route (the screen must not ask again). Absent = false. */
  speakerConfirmed?: boolean;
}

export interface PracticeEngine {
  readonly clip: ClipRecord;
  readonly phrase: PhraseRecord;
  getSnapshot(): PracticeSnapshot;
  /** Calls `listener` after every snapshot change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Playhead in phrase seconds (reference time); NaN when nothing plays. Read from requestAnimationFrame, not React state. */
  position(): number;
  setOptions(patch: Partial<PracticeOptions>): void;
  /** Plays the guide once (or loops it). Needs no microphone. */
  listen(): Promise<void>;
  /**
   * Count-in, take, analysis, comparison, save. Prepares the microphone on the first call of a visit.
   * `speakerConfirmed`: the singer has just said "I have headphones on" in the screen's own question, so a sing-along take
   * is not refused for a route that does not look like headphones (the names iOS gives wired and some Bluetooth headsets
   * do not always say so). It lasts until the route changes.
   */
  sing(opts?: { speakerConfirmed?: boolean }): Promise<void>;
  /** Stops the guide or cancels a take in progress (nothing is scored; the snapshot message says so). */
  stop(): void;
  /**
   * While recording: ends the take now and scores what was sung (the usual "Done"). In any other state it does what stop() does.
   * Optional so older fakes keep working; the screen falls back to stop().
   */
  finish?(): void;
  /** Turns the microphone (and the audio context) off now, when nothing is running. The next Sing opens it again. */
  releaseMicrophone?(): void;
  /** After a result: hear the original, your take, or both side by side (guide left, you right, lined up by the sync offset). */
  playAttempt(which: 'original' | 'you' | 'both'): Promise<void>;
  /** Releases the microphone and the audio context. Idempotent. */
  dispose(): void;
}
