// What the singing screens need from the outside world (prompt playback, the microphone, the scorers, ids, clocks),
// behind one seam so tests can inject fakes. Screens read it from context (SingDepsProvider) and an optional
// `deps` prop; anything not given falls back to the real modules.

import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { platformKind, type PlatformKind } from '../../../pwa/platform';
import { playEvents, startDroneFor, startSkillCapture, waitSec, type PromptPlayback, type SkillCapture, type SkillCaptureOptions } from '../../../skills/audio';
import { emptySkillsBests, loadSkillsStore, skillsId } from '../../../skills/progress';
import { createLockTracker, scoreHeldNote, scoreHiss, scoreLongTone, scoreSequence, scoreSungInterval, summarisePitchTest } from '../../../skills/score';
import type { SkillsBests, ToneEvent } from '../../../skills/types';

export interface SingDeps {
  playEvents(events: readonly ToneEvent[], opts: { a4Hz: number; onEvent?(e: ToneEvent, i: number): void }): Pick<PromptPlayback, 'done' | 'stop' | 'stalled'>;
  waitSec(sec: number, signal?: AbortSignal): Promise<boolean>;
  startCapture(opts: SkillCaptureOptions): Promise<SkillCapture>;
  startDrone(midi: number, a4Hz: number): { stop(): void };
  scoreHeldNote: typeof scoreHeldNote;
  summarisePitchTest: typeof summarisePitchTest;
  createLockTracker: typeof createLockTracker;
  scoreSungInterval: typeof scoreSungInterval;
  scoreSequence: typeof scoreSequence;
  scoreHiss: typeof scoreHiss;
  scoreLongTone: typeof scoreLongTone;
  newId(): string;
  nowMs(): number;
  platform(): PlatformKind;
  /** Personal bests for the breath screen when the page does not pass them. */
  loadBests(): SkillsBests;
  /** Lets the "Scoring..." state paint before a scorer that can take most of a second on a long take. */
  yieldToPaint(): Promise<void>;
  /** Pause between the prompt and the microphone opening. */
  beforeCaptureSec?: number;
}

export const DEFAULT_SING_DEPS: SingDeps = {
  playEvents: (events, opts) => playEvents(events, opts),
  waitSec,
  startCapture: startSkillCapture,
  startDrone: (midi, a4Hz) => startDroneFor(midi, a4Hz),
  scoreHeldNote,
  summarisePitchTest,
  createLockTracker,
  scoreSungInterval,
  scoreSequence,
  scoreHiss,
  scoreLongTone,
  newId: skillsId,
  nowMs: () => Date.now(),
  platform: () => platformKind(),
  loadBests: () => {
    try {
      return loadSkillsStore().bests;
    } catch {
      return emptySkillsBests();
    }
  },
  yieldToPaint: () => new Promise((resolve) => setTimeout(resolve, 30)),
};

const SingDepsContext = createContext<Partial<SingDeps> | null>(null);

/** Overrides the singing screens' dependencies below it (tests, the workout). */
export function SingDepsProvider(props: { deps: Partial<SingDeps>; children?: ReactNode }) {
  return createElement(SingDepsContext.Provider, { value: props.deps }, props.children);
}

/** The dependencies a screen uses: defaults, then the context, then the screen's own prop. Stable per inputs. */
export function useSingDeps(own?: Partial<SingDeps>): SingDeps {
  const ctx = useContext(SingDepsContext);
  return useMemo(() => ({ ...DEFAULT_SING_DEPS, ...(ctx ?? {}), ...(own ?? {}) }), [ctx, own]);
}
