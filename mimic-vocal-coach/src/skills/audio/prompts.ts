// Prompt playback for the Skills exercises: plays the pure ToneEvents built by src/skills/theory/prompts.ts (notes,
// intervals, the I-IV-V7-I cadence, lines) with the soft piano voice of src/audio/tones.ts, scheduled on the
// AudioContext clock. The UI follows the playback through onEvent and waits on `done` before it opens the microphone,
// so a prompt never bleeds into a take. See README.md.

import { prepareForCapture } from '../../audio/audioSession';
import { scheduleTones, startDrone, type ScheduledTone, type ToneSchedule } from '../../audio/tones';
import { midiToHz } from '../../dsp/music';
import type { ToneEvent } from '../types';

/** Default master volume of the prompts (the same as the practice tones). */
export const DEFAULT_PROMPT_VOLUME = 0.35;

export const PLAYBACK_TUNING = Object.freeze({
  /** Scheduling headroom between the call and the first sound. */
  leadSec: 0.08,
  /** How often the player reads the audio clock to fire onEvent and detect the end. */
  pollMs: 20,
  /** If the audio clock has not moved for this long, the browser is keeping audio blocked: give up (nothing was heard). */
  stallMs: 1500,
  /** Hard wall-clock limit beyond the prompt's own length, whatever the clock says. */
  wallGraceMs: 4000,
  /** Voice peak of a single note (as playNote). */
  notePeak: 0.8,
});

// Keep prompts on a piano's range whatever the data says (as tones.ts does).
const MIDI_MIN = 21;
const MIDI_MAX = 108;

let promptVolume = DEFAULT_PROMPT_VOLUME;

/** Changes the master volume used when playEvents is not given one (0..1, in memory for this page session). */
export function setPromptVolume(volume: number): void {
  if (Number.isFinite(volume)) promptVolume = Math.min(1, Math.max(0, volume));
}

export function getPromptVolume(): number {
  return promptVolume;
}

export interface PlayEventsOptions {
  a4Hz: number;
  /** Master volume 0..1 (default: getPromptVolume()). */
  volume?: number;
  /** Fires as each event starts sounding (on the audio clock), in start order. */
  onEvent?(e: ToneEvent, i: number): void;
}

export interface PromptPlayback {
  /** Seconds from the call until `done` resolves with 'ended' (lead-in + the events + the last release). */
  durationSec: number;
  /** 'ended' when the prompt finished (or could not play at all), 'stopped' after stop(). Never rejects. */
  done: Promise<'ended' | 'stopped'>;
  stop(): void;
  readonly playing: boolean;
  /**
   * True when nothing could be heard: no Web Audio, or the browser kept the audio clock stopped (an iPhone can
   * do this outside a tap). The UI should offer a "Play again" button, which is a tap and unlocks the audio.
   */
  readonly stalled: boolean;
}

/** Per-note peak for an event: its gain, with a little headroom for chords of more than two notes. */
export function eventPeak(e: ToneEvent): number {
  const gain = Math.min(1, Math.max(0, e.gain ?? 1));
  const n = Math.max(1, e.midis.length);
  return (PLAYBACK_TUNING.notePeak * gain) / (n > 2 ? Math.sqrt(n / 2) : 1);
}

/** The tones a list of events schedules (one per note of each event), in tones.ts terms. Pure. */
export function eventsToTones(events: readonly ToneEvent[], a4Hz: number): ScheduledTone[] {
  const out: ScheduledTone[] = [];
  for (const e of events) {
    if (!Number.isFinite(e.startSec) || !Number.isFinite(e.durSec) || e.durSec <= 0) continue;
    const peak = eventPeak(e);
    for (const m of e.midis) {
      if (!Number.isFinite(m)) continue;
      const midi = Math.min(MIDI_MAX, Math.max(MIDI_MIN, m));
      out.push({ hz: midiToHz(midi, a4Hz), startSec: Math.max(0, e.startSec), durSec: e.durSec, peak });
    }
  }
  return out;
}

const active = new Set<PromptPlayback>();
let captureOpen = 0;

/** Stops every prompt that is still playing (startSkillCapture calls this so nothing plays into a take). */
export function stopAllPrompts(): void {
  for (const p of [...active]) p.stop();
}

/** Capture bookkeeping (capture.ts): while a microphone take is open, playback must not leave a 'playback' session behind. */
export function noteCaptureOpen(open: boolean): void {
  captureOpen = Math.max(0, captureOpen + (open ? 1 : -1));
}

/** tones.ts sets the iPhone audio session to 'playback', which would stop an open microphone: put it back. */
function keepCaptureSession(): void {
  if (captureOpen > 0) prepareForCapture();
}

const now = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * Plays `events` with the piano voice. Times follow the AudioContext clock, so the sound is sample-accurate and
 * onEvent / done stay in step with it even when the context starts late. Never throws.
 */
export function playEvents(events: readonly ToneEvent[], opts: PlayEventsOptions): PromptPlayback {
  const a4Hz = Number.isFinite(opts.a4Hz) && opts.a4Hz > 0 ? opts.a4Hz : 440;
  const tones = eventsToTones(events, a4Hz);
  const sched: ToneSchedule | null = tones.length > 0 ? scheduleTones(tones, { volume: opts.volume ?? promptVolume, leadSec: PLAYBACK_TUNING.leadSec }) : null;
  keepCaptureSession();

  let resolveDone: (v: 'ended' | 'stopped') => void = () => undefined;
  const done = new Promise<'ended' | 'stopped'>((resolve) => {
    resolveDone = resolve;
  });

  if (!sched) {
    // Nothing to play (no events, or no Web Audio): end asynchronously, like a very short prompt.
    let playing = true;
    const stalled = tones.length > 0;
    const handle: PromptPlayback = {
      durationSec: 0,
      done,
      stop() {
        if (!playing) return;
        playing = false;
        resolveDone('stopped');
      },
      get playing() {
        return playing;
      },
      get stalled() {
        return stalled;
      },
    };
    setTimeout(() => {
      if (!playing) return;
      playing = false;
      resolveDone('ended');
    }, 0);
    return handle;
  }

  const ac = sched.context;
  const order = events
    .map((e, i) => ({ e, i, at: sched.t0 + Math.max(0, e.startSec) }))
    .filter(({ e }) => Number.isFinite(e.startSec) && Number.isFinite(e.durSec) && e.durSec > 0 && e.midis.some((m) => Number.isFinite(m)))
    .sort((a, b) => a.at - b.at || a.i - b.i);
  const durationSec = Math.max(0, sched.endTime - ac.currentTime);
  let next = 0;
  let playing = true;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wallStart = now();
  let lastClock = ac.currentTime;
  let lastMove = wallStart;

  const finish = (result: 'ended' | 'stopped') => {
    if (!playing) return;
    playing = false;
    if (timer) clearTimeout(timer);
    timer = null;
    // After a natural end the fade is inaudible; it tidies the bus. After a stop or a stall it silences what is left.
    sched.stop();
    active.delete(handle);
    resolveDone(result);
  };

  const tick = () => {
    timer = null;
    if (!playing) return;
    const clock = ac.currentTime;
    const wall = now();
    if (clock !== lastClock) {
      lastClock = clock;
      lastMove = wall;
    }
    while (next < order.length && clock >= order[next].at - 0.005) {
      const { e, i } = order[next++];
      try {
        opts.onEvent?.(e, i);
      } catch {
        // A UI callback must not break the playback.
      }
      if (!playing) return; // onEvent may have stopped it
    }
    if (clock >= sched.endTime) {
      finish('ended');
      return;
    }
    if (wall - lastMove >= PLAYBACK_TUNING.stallMs || wall - wallStart >= durationSec * 1000 + PLAYBACK_TUNING.wallGraceMs) {
      // The context never ran (or stopped running): silence what was scheduled so it cannot start later during a take.
      stalled = clock < sched.t0 + 0.05 || wall - lastMove >= PLAYBACK_TUNING.stallMs;
      finish('ended');
      return;
    }
    timer = setTimeout(tick, PLAYBACK_TUNING.pollMs);
  };

  const handle: PromptPlayback = {
    durationSec,
    done,
    stop: () => finish('stopped'),
    get playing() {
      return playing;
    },
    get stalled() {
      return stalled;
    },
  };
  active.add(handle);
  timer = setTimeout(tick, 0);
  return handle;
}

/** Holds `midi` until stop() (match-the-note drone; only after the singer said they wear headphones). */
export function startDroneFor(midi: number, a4Hz: number, volume: number = promptVolume * 0.8): { stop(): void } {
  const drone = startDrone(midi, { a4Hz, volume });
  keepCaptureSession();
  return drone;
}

/** Resolves after `sec` seconds, or early when the signal aborts. Resolves true when it ran to the end. */
export function waitSec(sec: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      },
      Math.max(0, sec * 1000),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
