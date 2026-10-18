// One microphone take for a Skills exercise: wraps createRecorder (src/audio/recorder.ts: raw PCM with the voice-call
// processing off, iPhone/Mac audio session, interruption reports, wake lock), reads the analyser about 33 times a second
// for a live pitch/level stream (single-frame YIN, as the LiveMonitor tuner), applies the SPEC's auto-stop rule and
// returns the samples for the pure scorers in src/skills/score. Start it only after the prompt has finished
// (playEvents(...).done, then PROMPT_TIMING.beforeCaptureSec): the microphone is never open while a prompt plays.

import { createRecorder, toRecorderError, type InterruptionReason, type Recorder } from '../../audio/recorder';
import { hzToMidi, midiToHz } from '../../dsp/music';
import { detectPitch } from '../../dsp/pitch';
import { blockLevel } from '../../ui/components/live';
import type { AutoStopRule, CaptureResult, LiveReading, StopReason, ToneEvent } from '../types';
import { PROMPT_TIMING } from '../theory/prompts';
import { createAutoStop, type AutoStop } from './autoStop';
import { noteCaptureOpen, playEvents, stopAllPrompts, waitSec, type PlayEventsOptions } from './prompts';

export { AUTO_STOP_RULES, AUTO_STOP_TUNING, createAutoStop, type AutoStop } from './autoStop';

export const CAPTURE_TUNING = Object.freeze({
  /** Analyser read interval: ~33 readings a second (a 2048-sample frame is 43-46 ms, so frames overlap). */
  pollMs: 30,
  /** Sung range for the live tuner (as LiveMonitor): below ~70 Hz and above ~1.1 kHz a mic mostly hears hum and whistles. */
  minHz: 70,
  maxHz: 1100,
  /** No pitch is looked for below this level (as LiveMonitor). */
  pitchGateDb: -60,
  /** Light smoothing: the median of the last five voiced readings (60 ms of delay) removes one- and two-frame octave flicks. */
  smoothCount: 5,
  /** Readings further apart than this are not smoothed together. */
  smoothMaxGapSec: 0.1,
  /** If the audio clock stalls, the take still ends this long after the rule's cap, by the wall clock. */
  wallCapGraceSec: 5,
  /** Most readings kept in the live log (10 minutes at ~33 a second; a take is capped at 300 s anyway). */
  maxLog: 20000,
});

/** One live reading from the analyser: level, and the pitch when there is one. `buf` should be analyser.fftSize long. */
export function readLive(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>, a4Hz: number, t: number): LiveReading {
  analyser.getFloatTimeDomainData(buf);
  const { rmsDb } = blockLevel(buf);
  const p = rmsDb > CAPTURE_TUNING.pitchGateDb ? detectPitch(buf, analyser.context.sampleRate, CAPTURE_TUNING.minHz, CAPTURE_TUNING.maxHz) : null;
  return {
    t,
    hz: p ? p.hz : null,
    midi: p ? hzToMidi(p.hz, a4Hz) : null,
    rmsDb,
    periodicity: p ? p.periodicity : 0,
  };
}

/** Light smoothing for the live stream: a voiced reading becomes the median of the last five voiced ones (close in time). */
export function createLiveSmoother(a4Hz: number): (r: LiveReading) => LiveReading {
  const last: { t: number; midi: number }[] = [];
  return (r) => {
    if (r.midi === null || !Number.isFinite(r.midi)) return r;
    last.push({ t: r.t, midi: r.midi });
    while (last.length > CAPTURE_TUNING.smoothCount) last.shift();
    while (last.length > 1 && r.t - last[0].t > CAPTURE_TUNING.smoothMaxGapSec * (last.length - 1)) last.shift();
    if (last.length < 3) return r;
    const sorted = last.map((x) => x.midi).sort((a, b) => a - b);
    const midi = sorted[(sorted.length - 1) >> 1];
    return { ...r, midi, hz: midiToHz(midi, a4Hz) };
  };
}

export interface SkillCaptureOptions {
  rule: AutoStopRule;
  a4Hz: number;
  /** Every live reading (smoothed), ~33 a second: drive the needle and the trace from it. */
  onReading?(r: LiveReading): void;
  /** The rule (or the cap) ended the take. The recorder is already stopping; call stop() for the result. */
  onAutoStop?(reason: StopReason): void;
  /**
   * The take lost its microphone (see InterruptionReason). Every reason but 'no-audio' also ends the take with
   * stoppedBy 'interrupted' (show interruptionText / DESKTOP_INTERRUPTION_TEXT and offer Try again); 'no-audio'
   * is only reported, because sound may still arrive.
   */
  onInterruption?(reason: InterruptionReason): void;
  /** Test seam: the recorder to use (default createRecorder). */
  recorderFactory?: () => Recorder;
}

export interface SkillCaptureResult extends CaptureResult {
  /** The live readings of the take (times are the capture's audio clock, so they match the samples to a frame or so). */
  log: LiveReading[];
  /** The live note count at the end (cautious; the scorer's own segmentation is the real count). */
  notesHeard: number;
}

export interface SkillCapture {
  /** For a level meter or a scope; null once the take has ended. */
  readonly analyser: AnalyserNode | null;
  /** Seconds of the take so far (audio clock: it does not run while the system has suspended capture). */
  readonly elapsedSec: number;
  /** Live note count and held-note progress (for "hold it ... 1.2 s"). */
  readonly notesHeard: number;
  readonly heldSec: number;
  readonly log: readonly LiveReading[];
  /** Ends the take. The first reason wins: after an auto-stop this returns that result with its own reason. */
  stop(reason: StopReason): Promise<SkillCaptureResult>;
  /** Ends the take and drops the audio. */
  cancel(): void;
}

const wallNow = (): number => Date.now();

/**
 * Opens the microphone for one response and starts the live stream. Rejects with a RecorderError ('denied',
 * 'unsupported', 'no-device'; show err.message, which already uses the Mac or iPhone words). Stops any prompt that
 * is still playing first, so nothing from the speakers lands in the take.
 */
export async function startSkillCapture(opts: SkillCaptureOptions): Promise<SkillCapture> {
  stopAllPrompts();
  const a4Hz = Number.isFinite(opts.a4Hz) && opts.a4Hz > 0 ? opts.a4Hz : 440;
  const rec = (opts.recorderFactory ?? createRecorder)();
  const auto: AutoStop = createAutoStop(opts.rule);
  const smooth = createLiveSmoother(a4Hz);
  const log: LiveReading[] = [];
  const capSec = Number.isFinite(opts.rule.capSec) && opts.rule.capSec > 0 ? opts.rule.capSec : 30;

  let state: 'starting' | 'live' | 'ended' = 'starting';
  let interrupted: InterruptionReason | null = null;
  let pendingInterrupt = false;
  let result: Promise<SkillCaptureResult> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frozenElapsed = 0;
  let open = false;

  rec.onInterruption = (reason) => {
    interrupted ??= reason;
    try {
      opts.onInterruption?.(reason);
    } catch {
      // UI callback errors must not break the take.
    }
    if (reason === 'no-audio') return;
    if (state === 'live') autoStop('interrupted');
    else pendingInterrupt = true;
  };

  noteCaptureOpen(true);
  open = true;
  const closeBookkeeping = () => {
    if (!open) return;
    open = false;
    noteCaptureOpen(false);
  };

  try {
    await rec.start();
  } catch (err) {
    closeBookkeeping();
    throw toRecorderError(err);
  }

  const analyser = rec.analyser;
  const buf = analyser ? new Float32Array(analyser.fftSize) : null;
  const ctx = analyser?.context ?? null;
  const ctx0 = ctx ? ctx.currentTime : 0;
  const wall0 = wallNow();
  let lastClock = -1;

  const elapsed = (): number => {
    if (state === 'ended') return frozenElapsed;
    if (ctx) return Math.max(0, ctx.currentTime - ctx0);
    return rec.capturedSec ?? (wallNow() - wall0) / 1000;
  };

  const finish = (reason: StopReason): Promise<SkillCaptureResult> => {
    if (result) return result;
    frozenElapsed = elapsed();
    state = 'ended';
    if (timer) clearTimeout(timer);
    timer = null;
    const notesHeard = auto.notesHeard;
    result = rec
      .stop()
      .then((out) => ({
        samples: out.samples,
        sampleRate: out.sampleRate,
        stoppedBy: reason,
        interrupted: out.interrupted ?? interrupted ?? null,
        log,
        notesHeard,
      }))
      .catch(() => ({ samples: new Float32Array(0), sampleRate: ctx?.sampleRate ?? 48000, stoppedBy: reason, interrupted, log, notesHeard }))
      .finally(closeBookkeeping);
    return result;
  };

  function autoStop(reason: StopReason): void {
    if (state !== 'live') return;
    void finish(reason);
    try {
      opts.onAutoStop?.(reason);
    } catch {
      // UI callback errors must not break the take.
    }
  }

  const tick = () => {
    timer = null;
    if (state !== 'live') return;
    const t = elapsed();
    // Only read when new audio has arrived (the clock does not move while the system suspends capture).
    if (analyser && buf && (!ctx || ctx.currentTime !== lastClock)) {
      lastClock = ctx ? ctx.currentTime : t;
      let r: LiveReading;
      try {
        r = smooth(readLive(analyser, buf, a4Hz, t));
      } catch {
        r = { t, hz: null, midi: null, rmsDb: -120, periodicity: 0 };
      }
      if (log.length < CAPTURE_TUNING.maxLog) log.push(r);
      try {
        opts.onReading?.(r);
      } catch {
        // UI callback errors must not break the take.
      }
      if (state !== 'live') return; // onReading may have stopped the take
      const reason = auto.push(r);
      if (reason) {
        autoStop(reason);
        return;
      }
    } else if (!analyser && t >= capSec) {
      autoStop('cap');
      return;
    }
    if ((wallNow() - wall0) / 1000 >= capSec + CAPTURE_TUNING.wallCapGraceSec) {
      autoStop('cap');
      return;
    }
    timer = setTimeout(tick, CAPTURE_TUNING.pollMs);
  };

  state = 'live';
  if (pendingInterrupt) autoStop('interrupted');
  else timer = setTimeout(tick, 0);

  return {
    get analyser() {
      return state === 'live' ? rec.analyser : null;
    },
    get elapsedSec() {
      return elapsed();
    },
    get notesHeard() {
      return auto.notesHeard;
    },
    get heldSec() {
      return auto.heldSec;
    },
    get log() {
      return log;
    },
    stop(reason: StopReason) {
      return finish(reason);
    },
    cancel() {
      if (state === 'ended' && result) return;
      frozenElapsed = elapsed();
      state = 'ended';
      if (timer) clearTimeout(timer);
      timer = null;
      rec.cancel();
      closeBookkeeping();
      const sampleRate = ctx?.sampleRate ?? 48000;
      result = Promise.resolve({ samples: new Float32Array(0), sampleRate, stoppedBy: 'button' as StopReason, interrupted, log, notesHeard: auto.notesHeard });
    },
  };
}

export interface PromptThenCaptureOptions extends Omit<SkillCaptureOptions, 'a4Hz'> {
  a4Hz: number;
  volume?: number;
  onEvent?: PlayEventsOptions['onEvent'];
  /** Called when the prompt has finished and the microphone is about to open ("Get ready"). */
  onPromptDone?(info: { stalled: boolean }): void;
  /** Silence between the prompt and the microphone (default PROMPT_TIMING.beforeCaptureSec). */
  gapSec?: number;
  /** Abort while the prompt plays or during the gap: resolves null and opens no microphone. Later, it cancels the take. */
  signal?: AbortSignal;
}

/**
 * The per-item flow in one call: play the prompt, wait for it to end and ring out, then open the microphone.
 * Resolves null when aborted (or the prompt was stopped) before the microphone opened. Capture errors reject
 * as in startSkillCapture.
 */
export async function promptThenCapture(events: readonly ToneEvent[], opts: PromptThenCaptureOptions): Promise<SkillCapture | null> {
  if (opts.signal?.aborted) return null;
  const playback = playEvents(events, { a4Hz: opts.a4Hz, volume: opts.volume, onEvent: opts.onEvent });
  const onAbort = () => playback.stop();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const how = await playback.done;
  opts.signal?.removeEventListener('abort', onAbort);
  if (how === 'stopped' || opts.signal?.aborted) return null;
  opts.onPromptDone?.({ stalled: playback.stalled });
  const ran = await waitSec(events.length > 0 ? (opts.gapSec ?? PROMPT_TIMING.beforeCaptureSec) : 0, opts.signal);
  if (!ran) return null;
  const cap = await startSkillCapture(opts);
  // An abort after the microphone opened (e.g. the screen closed) drops the take.
  if (opts.signal?.aborted) {
    cap.cancel();
    return null;
  }
  opts.signal?.addEventListener('abort', () => cap.cancel(), { once: true });
  return cap;
}
