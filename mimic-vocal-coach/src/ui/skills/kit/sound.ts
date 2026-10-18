// One prompt at a time for the Skills shell screens: starting a new prompt stops the one still playing. A thin seam over
// src/skills/audio playEvents, so screen tests can replace it with vi.mock.

import { getPromptVolume, playEvents, setPromptVolume, type PromptPlayback } from '../../../skills/audio/prompts';
import { readJson, writeJson } from '../../../storage/local';
import type { ToneEvent } from '../../../skills/types';

let current: PromptPlayback | null = null;

/** Plays `events` with the piano voice; any prompt still sounding is stopped first. Never throws. */
export function playPrompt(events: readonly ToneEvent[], a4Hz: number, onEvent?: (e: ToneEvent, i: number) => void): PromptPlayback {
  stopPrompt();
  const p = playEvents(events, { a4Hz, onEvent });
  current = p;
  void p.done.then(() => {
    if (current === p) current = null;
  });
  return p;
}

/** Stops the prompt that is playing, if any. */
export function stopPrompt(): void {
  const p = current;
  current = null;
  try {
    p?.stop();
  } catch {
    // A prompt that cannot stop has nothing left to say.
  }
}

// ---------------------------------------------------------------------------------------------
// Prompt volume, remembered in this browser (a convenience: removed with the app's other keys by "Delete everything").

export const PROMPT_VOLUME_KEY = 'mimic:v1:skills-volume';

/** Applies the remembered prompt volume (if any) and returns the volume now in use, 0..1. */
export function loadPromptVolume(): number {
  try {
    const r = readJson(PROMPT_VOLUME_KEY);
    if (r.available && typeof r.value === 'number' && Number.isFinite(r.value)) setPromptVolume(r.value);
  } catch {
    // Keep the default.
  }
  return getPromptVolume();
}

/** Sets and remembers the prompt volume (0..1). */
export function savePromptVolume(v: number): number {
  setPromptVolume(v);
  const now = getPromptVolume();
  writeJson(PROMPT_VOLUME_KEY, now);
  return now;
}
