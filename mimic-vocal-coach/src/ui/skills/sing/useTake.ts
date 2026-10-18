// One sung item, start to finish: play the prompt (microphone closed), wait for the room to ring out, open the
// microphone with the exercise's auto-stop rule, stream live readings for the needle and the trace, stop by button,
// key, auto-stop or cap, then score. Errors come back as values the screen shows with the existing Mac/iPhone wording.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InterruptionReason } from '../../../audio/recorder';
import { isDesktopKind } from '../../../pwa/platform';
import { DESKTOP_INTERRUPTION_TEXT, interruptionText } from '../../../pwa/words';
import type { SkillCapture, SkillCaptureResult } from '../../../skills/audio';
import { PROMPT_TIMING } from '../../../skills/theory';
import type { AutoStopRule, LiveReading, StopReason, ToneEvent } from '../../../skills/types';
import type { SingDeps } from './deps';

export type TakePhase = 'idle' | 'prompt' | 'gap' | 'listening' | 'scoring';

export type TakeOutcome<T> =
  | { kind: 'scored'; value: T; take: SkillCaptureResult }
  | { kind: 'interrupted'; message: string }
  | { kind: 'mic-error'; message: string }
  | { kind: 'stalled'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/** The notice for an outcome that is neither scored nor cancelled. */
export function outcomeError(out: TakeOutcome<unknown>): { title: string; message: string } | null {
  switch (out.kind) {
    case 'mic-error':
      return { title: 'The microphone did not start', message: out.message };
    case 'interrupted':
      return { title: 'Take interrupted', message: out.message };
    case 'stalled':
      return { title: 'Nothing played', message: out.message };
    case 'failed':
      return { title: 'That take could not be scored', message: out.message };
    default:
      return null;
  }
}

export interface TakeRunOptions<T> {
  events: readonly ToneEvent[];
  rule: AutoStopRule;
  a4Hz: number;
  onEvent?(e: ToneEvent, i: number): void;
  /** Every live reading while the microphone is open. */
  onReading?(r: LiveReading): void;
  /** End the take from a reading (the lock tracker); return the reason or null. */
  shouldStop?(r: LiveReading): StopReason | null;
  /** Started when the microphone opens; the returned function runs when it closes (the drone). */
  duringCapture?(): (() => void) | void;
  score(take: SkillCaptureResult): T;
}

/** Most live readings kept for the trace (about 30 s at 33 a second). */
const MAX_TRACE = 1000;

export function interruptionMessage(reason: InterruptionReason | null, deps: SingDeps): string {
  const kind = deps.platform();
  const why = isDesktopKind(kind) && reason && DESKTOP_INTERRUPTION_TEXT[reason] ? DESKTOP_INTERRUPTION_TEXT[reason] : interruptionText(kind);
  return `That take was interrupted, so it was not scored. ${why}`;
}

export function stalledMessage(deps: SingDeps): string {
  return isDesktopKind(deps.platform())
    ? 'The prompt could not play, so the microphone stayed closed. Check the volume and the output in the menu bar, then press Play again.'
    : 'The prompt could not play, so the microphone stayed closed. Check the volume and the ring/silent switch, then tap Play again.';
}

export function noAudioMessage(deps: SingDeps): string {
  return isDesktopKind(deps.platform())
    ? DESKTOP_INTERRUPTION_TEXT['no-audio']
    : 'No sound has reached the app yet. Check that nothing else is using the microphone.';
}

export interface TakeController {
  phase: TakePhase;
  /** Latest live reading (null before the first one). */
  live: LiveReading | null;
  /** Live readings of the current take, oldest first. */
  trace: readonly LiveReading[];
  /** Seconds since the microphone opened. */
  elapsedSec: number;
  /** Index of the prompt event that is sounding (for highlighting), null otherwise. */
  activeEvent: number | null;
  /** True after the recorder reported that no audio arrived yet. */
  noAudio: boolean;
  /** Live note count / held seconds from the capture (for "hold it" progress). */
  heldSec: number;
  run<T>(opts: TakeRunOptions<T>): Promise<TakeOutcome<T>>;
  /** Plays a prompt alone (Space = replay before singing). */
  play(events: readonly ToneEvent[], a4Hz: number, onEvent?: (e: ToneEvent, i: number) => void): Promise<void>;
  stop(reason?: StopReason): void;
  cancel(): void;
}

export function useTake(deps: SingDeps): TakeController {
  const [phase, setPhase] = useState<TakePhase>('idle');
  const [live, setLive] = useState<LiveReading | null>(null);
  const [activeEvent, setActiveEvent] = useState<number | null>(null);
  const [noAudio, setNoAudio] = useState(false);
  const [heldSec, setHeldSec] = useState(0);
  const traceRef = useRef<LiveReading[]>([]);
  const capRef = useRef<SkillCapture | null>(null);
  const stopRef = useRef<((r: StopReason) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playRef = useRef<{ stop(): void } | null>(null);
  const mounted = useRef(true);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const safe = useCallback(<A>(fn: (a: A) => void) => (a: A) => {
    if (mounted.current) fn(a);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playRef.current?.stop();
    playRef.current = null;
    capRef.current?.cancel();
    capRef.current = null;
    stopRef.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  const stop = useCallback((reason: StopReason = 'button') => {
    stopRef.current?.(reason);
  }, []);

  const play = useCallback(
    async (events: readonly ToneEvent[], a4Hz: number, onEvent?: (e: ToneEvent, i: number) => void) => {
      if (capRef.current) return;
      playRef.current?.stop();
      const setP = safe(setPhase);
      const setA = safe(setActiveEvent);
      setP('prompt');
      const pb = depsRef.current.playEvents(events, {
        a4Hz,
        onEvent: (e, i) => {
          setA(e.index ?? i);
          onEvent?.(e, i);
        },
      });
      playRef.current = pb;
      await pb.done;
      if (playRef.current === pb) playRef.current = null;
      setA(null);
      setP('idle');
    },
    [safe],
  );

  const run = useCallback(
    async <T>(o: TakeRunOptions<T>): Promise<TakeOutcome<T>> => {
      cancel();
      const d = depsRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      const setP = safe(setPhase);
      const setA = safe(setActiveEvent);
      const setL = safe(setLive);
      const setH = safe(setHeldSec);
      traceRef.current = [];
      setL(null);
      setH(0);
      safe(setNoAudio)(false);
      const cancelled = (): TakeOutcome<T> => {
        setA(null);
        setP('idle');
        return { kind: 'cancelled' };
      };

      if (o.events.length > 0) {
        setP('prompt');
        const pb = d.playEvents(o.events, {
          a4Hz: o.a4Hz,
          onEvent: (e, i) => {
            setA(e.index ?? i);
            o.onEvent?.(e, i);
          },
        });
        playRef.current = pb;
        const how = await pb.done;
        playRef.current = null;
        setA(null);
        if (ac.signal.aborted || how === 'stopped') return cancelled();
        if (pb.stalled) {
          setP('idle');
          return { kind: 'stalled', message: stalledMessage(d) };
        }
        setP('gap');
        const ran = await d.waitSec(d.beforeCaptureSec ?? PROMPT_TIMING.beforeCaptureSec, ac.signal);
        if (!ran || ac.signal.aborted) return cancelled();
      }

      let resolveStop: (r: StopReason) => void = () => undefined;
      const stopped = new Promise<StopReason>((resolve) => {
        resolveStop = resolve;
      });
      let interruption: InterruptionReason | null = null;
      let cap: SkillCapture;
      try {
        cap = await d.startCapture({
          rule: o.rule,
          a4Hz: o.a4Hz,
          onReading: (r) => {
            const tr = traceRef.current;
            tr.push(r);
            if (tr.length > MAX_TRACE) tr.splice(0, tr.length - MAX_TRACE);
            setL(r);
            if (capRef.current) setH(capRef.current.heldSec);
            o.onReading?.(r);
            const s = o.shouldStop?.(r);
            if (s) resolveStop(s);
          },
          onAutoStop: (reason) => resolveStop(reason),
          onInterruption: (reason) => {
            if (reason === 'no-audio') {
              safe(setNoAudio)(true);
              return;
            }
            interruption = reason;
            resolveStop('interrupted');
          },
        });
      } catch (err) {
        setP('idle');
        if (ac.signal.aborted) return { kind: 'cancelled' };
        const message = err instanceof Error && err.message ? err.message : 'The microphone could not start.';
        return { kind: 'mic-error', message };
      }
      if (ac.signal.aborted) {
        cap.cancel();
        return cancelled();
      }
      capRef.current = cap;
      stopRef.current = (r) => resolveStop(r);
      ac.signal.addEventListener('abort', () => resolveStop('button'), { once: true });
      let endDuring: (() => void) | void = undefined;
      try {
        endDuring = o.duringCapture?.();
      } catch {
        endDuring = undefined;
      }
      setP('listening');

      const reason = await stopped;
      stopRef.current = null;
      try {
        endDuring?.();
      } catch {
        // A drone that will not stop must not break the take.
      }
      if (ac.signal.aborted) {
        cap.cancel();
        capRef.current = null;
        return cancelled();
      }
      const take = await cap.stop(reason);
      capRef.current = null;
      if (ac.signal.aborted) return cancelled();
      if (take.stoppedBy === 'interrupted' || reason === 'interrupted') {
        setP('idle');
        return { kind: 'interrupted', message: interruptionMessage(take.interrupted ?? interruption, d) };
      }
      setP('scoring');
      await d.yieldToPaint();
      if (ac.signal.aborted) return cancelled();
      let value: T;
      try {
        value = o.score(take);
      } catch {
        return { kind: 'failed', message: 'Something went wrong while measuring that take. Nothing was saved; please try again.' };
      } finally {
        setP('idle');
      }
      if (abortRef.current === ac) abortRef.current = null;
      return { kind: 'scored', value, take };
    },
    [cancel, safe],
  );

  const elapsedSec = live ? Math.max(0, live.t) : 0;
  return { phase, live, trace: traceRef.current, elapsedSec, activeEvent, noAudio, heldSec, run, play, stop, cancel };
}

// ---------------------------------------------------------------------------------------------
// Keyboard: Space = play / replay, Return = start / stop singing, digits for answers. Ignored while a text field
// has focus, and for Space/Return on a focused control (the browser already activates it).

export interface SkillKeys {
  onSpace?(): void;
  onReturn?(): void;
}

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function isControl(el: Element | null): boolean {
  if (!el) return false;
  if (['BUTTON', 'A', 'SUMMARY', 'INPUT', 'LABEL'].includes(el.tagName)) return true;
  const role = el.getAttribute('role');
  return role === 'button' || role === 'radio' || role === 'link' || role === 'tab' || role === 'checkbox';
}

/** Document-level shortcuts for a screen; the latest handlers are used without re-subscribing. */
export function useSkillKeys(keys: SkillKeys, enabled = true): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      if (isTextField(target)) return;
      const isSpace = e.key === ' ' || e.code === 'Space';
      const isReturn = e.key === 'Enter';
      if (!isSpace && !isReturn) return;
      if (isControl(target)) return;
      const h = isSpace ? ref.current.onSpace : ref.current.onReturn;
      if (!h) return;
      e.preventDefault();
      h();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
