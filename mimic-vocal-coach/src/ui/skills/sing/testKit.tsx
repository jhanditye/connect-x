// Test fakes for the singing screens: prompt playback that ends at once, a microphone capture the test drives by
// hand (readings, auto-stop, interruptions, start errors), canned scorers and a React harness. The app does not use it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { RecorderError, type InterruptionReason, type RecorderErrorKind } from '../../../audio/recorder';
import type { SkillCapture, SkillCaptureOptions, SkillCaptureResult } from '../../../skills/audio';
import { DEFAULT_SKILLS_PREFS, emptySkillsBests, emptySkillsStats } from '../../../skills/progress';
import { DEFAULT_SETTINGS } from '../../../storage/settings';
import type { HeldNoteScore, HissScore, LiveReading, LongToneScore, SequenceScore, SequenceTarget, SkillsPrefs, StopReason, SungIntervalScore, ToneEvent, IntervalTarget } from '../../../skills/types';
import type { SingDeps } from './deps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export class FakeCapture implements SkillCapture {
  stoppedBy: StopReason | null = null;
  cancelled = false;
  interrupted: InterruptionReason | null = null;
  t = 0;
  /** What stop() returns as the take (default: 0.1 s of silence). */
  samples: Float32Array | null = null;
  sampleRate = 16000;
  constructor(readonly opts: SkillCaptureOptions) {}
  get analyser() {
    return null;
  }
  get elapsedSec() {
    return this.t;
  }
  get notesHeard() {
    return 0;
  }
  get heldSec() {
    return 0;
  }
  get log() {
    return [];
  }
  /** A live reading at the next 30 ms tick (midi null = unvoiced). */
  emit(midi: number | null, rmsDb = -25): void {
    this.t += 0.03;
    const r: LiveReading = { t: this.t, hz: midi === null ? null : 440 * 2 ** ((midi - 69) / 12), midi, rmsDb, periodicity: midi === null ? 0 : 0.9 };
    this.opts.onReading?.(r);
  }
  autoStop(reason: StopReason = 'auto-silence'): void {
    this.stoppedBy ??= reason;
    this.opts.onAutoStop?.(reason);
  }
  interrupt(reason: InterruptionReason): void {
    this.interrupted = reason;
    this.opts.onInterruption?.(reason);
    if (reason !== 'no-audio') this.autoStop('interrupted');
  }
  stop(reason: StopReason): Promise<SkillCaptureResult> {
    this.stoppedBy ??= reason;
    return Promise.resolve({ samples: this.samples ?? new Float32Array(1600), sampleRate: this.sampleRate, stoppedBy: this.stoppedBy, interrupted: this.interrupted, log: [], notesHeard: 0 });
  }
  cancel(): void {
    this.cancelled = true;
  }
}

export interface FakeWorld {
  deps: SingDeps;
  plays: ToneEvent[][];
  captures: FakeCapture[];
  drones: number[];
  dronesStopped: number;
  /** The next startCapture rejects with this. */
  failNext: RecorderErrorKind | null;
  stallNext: boolean;
  get last(): FakeCapture;
}

export function heldScore(over: Partial<HeldNoteScore> = {}): HeldNoteScore {
  return {
    status: 'ok',
    targetMidi: 57,
    sung: null,
    octaveOffset: 0,
    landingCents: -20,
    heldCents: -12,
    stabilityCents: 6,
    timeToLandSec: 0.4,
    within: true,
    register: 'mid',
    findings: [{ tone: 'good', text: 'Nicely in tune.' }],
    ...over,
  };
}

export function intervalScore(target: IntervalTarget, over: Partial<SungIntervalScore> = {}): SungIntervalScore {
  return { status: 'ok', target, first: null, second: null, referenceCents: 8, intervalCents: 32, targetCents: 40, sungSemitones: target.semitones * (target.direction === 'up' ? 1 : -1), wrongDirection: false, octaveOffset: 0, within: false, findings: [{ tone: 'work', text: 'The jump was a little wide.' }], ...over };
}

export function sequenceScore(target: SequenceTarget, over: Partial<SequenceScore> = {}): SequenceScore {
  const notes = target.notes.map((n, i) => ({
    index: i,
    degree: n.degree,
    written: n.written,
    expectedMidi: target.midis[i],
    sung: { startSec: i * 0.6, endSec: i * 0.6 + 0.5, midi: target.midis[i] + (i === 0 ? -0.41 : 0.02), landingMidi: null, stabilityCents: 5, steadySec: 0.4, meanRmsDb: -25 },
    cents: i === 0 ? -41 : 2,
    intervalCents: i === 0 ? null : i === 1 ? 43 : 0,
    within: i !== 0,
    octaveSlip: false,
  }));
  return {
    status: 'ok',
    target,
    notes,
    extras: [],
    missing: 0,
    octaveOffset: -1,
    noteAccuracy: (notes.length - 1) / notes.length,
    meanAbsCents: 8,
    biasCents: -5,
    meanAbsIntervalCents: 9,
    driftCents: -3,
    findings: [{ tone: 'work', text: 'Your 7 sat 41 cents flat.' }],
    ...over,
  };
}

export function hissScore(over: Partial<HissScore> = {}): HissScore {
  return { status: 'ok', durationSec: 21.4, steadinessDb: 1.2, noiseFloorDb: -70, startSec: 0.6, endSec: 22, levelTrace: [-30, -29, -30, -31], findings: [], ...over };
}

export function longToneScore(over: Partial<LongToneScore> = {}): LongToneScore {
  return { status: 'ok', durationSec: 14.2, midi: 52, pitchSdCents: 8, loudnessSdDb: 1.4, levelTrace: [-20, -21], pitchTrace: [52, 52.05, 51.98], findings: [], ...over };
}

export function fakeWorld(over: Partial<SingDeps> = {}): FakeWorld {
  let clock = 1_700_000_000_000;
  let ids = 0;
  const w: FakeWorld = {
    plays: [],
    captures: [],
    drones: [],
    dronesStopped: 0,
    failNext: null,
    stallNext: false,
    get last() {
      return w.captures[w.captures.length - 1];
    },
    deps: {
      playEvents: (events, opts) => {
        w.plays.push(events.slice());
        const stalled = w.stallNext;
        w.stallNext = false;
        events.forEach((e, i) => opts.onEvent?.(e, i));
        return { done: Promise.resolve('ended' as const), stop() {}, stalled };
      },
      waitSec: () => Promise.resolve(true),
      startCapture: (opts) => {
        if (w.failNext) {
          const kind = w.failNext;
          w.failNext = null;
          return Promise.reject(new RecorderError(kind, kind === 'denied' ? 'Microphone access is blocked. Allow it in System Settings, Privacy & Security, Microphone.' : 'No microphone was found.'));
        }
        const c = new FakeCapture(opts);
        w.captures.push(c);
        return Promise.resolve(c);
      },
      startDrone: (midi) => {
        w.drones.push(midi);
        return { stop: () => void w.dronesStopped++ };
      },
      scoreHeldNote: vi.fn((_s, _r, targetMidi: number) => heldScore({ targetMidi })),
      summarisePitchTest: vi.fn((notes: HeldNoteScore[], _tol: number) => {
        const ok = notes.filter((n) => n.status === 'ok');
        return {
          scored: ok.length,
          unscored: notes.length - ok.length,
          meanAbsCents: ok.length ? 12 : null,
          shareWithin: ok.length ? 0.8 : null,
          shareWithin50: ok.length ? 1 : null,
          biasCents: ok.length ? -12 : null,
          meanStabilityCents: ok.length ? 6 : null,
          meanTimeToLandSec: ok.length ? 0.4 : null,
          octaveSlips: 0,
          byRegister: {
            low: { n: 1, meanAbsCents: 10, biasCents: -10, shareWithin: 1 },
            mid: { n: 1, meanAbsCents: 12, biasCents: -12, shareWithin: 1 },
            high: { n: 0, meanAbsCents: null, biasCents: null, shareWithin: null },
          },
          findings: [{ tone: 'work' as const, text: 'You tend to sit 12 cents flat.' }],
        };
      }),
      createLockTracker: (targetMidi: number, tol: number) => {
        let since: number | null = null;
        let first: number | null = null;
        let locked = false;
        let lockSec: number | null = null;
        return {
          push(r: LiveReading) {
            const c = r.midi === null ? null : (r.midi - targetMidi) * 100;
            if (r.midi !== null && first === null) first = r.t;
            const inside = c !== null && Math.abs(c) <= tol;
            if (inside) since ??= r.t;
            else since = null;
            const heldSec = since === null ? 0 : r.t - since;
            if (!locked && heldSec >= 0.3) {
              locked = true;
              lockSec = (since ?? 0) - (first ?? 0);
            }
            return { centsNow: c, inside, heldSec, locked, lockSec };
          },
          reset() {},
        };
      },
      scoreSungInterval: vi.fn((_s, _r, target: IntervalTarget) => intervalScore(target)),
      scoreSequence: vi.fn((_s, _r, target: SequenceTarget) => sequenceScore(target)),
      scoreHiss: vi.fn(() => hissScore()),
      scoreLongTone: vi.fn(() => longToneScore()),
      newId: () => `id-${++ids}`,
      nowMs: () => (clock += 1000),
      platform: () => 'mac',
      loadBests: () => ({ ...emptySkillsBests(), hissSec: { value: 18, at: '2026-10-01T10:00:00.000Z' } }),
      yieldToPaint: () => Promise.resolve(),
      ...over,
    },
  };
  return w;
}

export function baseProps(prefs: Partial<SkillsPrefs> = {}) {
  return {
    settings: { ...DEFAULT_SETTINGS, voiceType: 'baritone' as const, a4Hz: 440 },
    prefs: { ...DEFAULT_SKILLS_PREFS, ...prefs },
    stats: emptySkillsStats(),
    seed: 7,
    onDone: vi.fn(),
    onExit: vi.fn(),
    onPrefs: vi.fn(),
  };
}

export interface Harness {
  container: HTMLDivElement;
  root: Root;
  text(): string;
  button(name: RegExp): HTMLButtonElement;
  maybeButton(name: RegExp): HTMLButtonElement | null;
  click(name: RegExp): Promise<void>;
  key(key: string, target?: Element): Promise<void>;
  flush(): Promise<void>;
  unmount(): void;
}

export function harness(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
  };
  const maybeButton = (name: RegExp) =>
    Array.from(container.querySelectorAll('button')).find((b) => name.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)) ?? null;
  const h: Harness = {
    container,
    root,
    text: () => container.textContent ?? '',
    maybeButton,
    button: (name) => {
      const b = maybeButton(name);
      if (!b) throw new Error(`No button ${name}; buttons: ${Array.from(container.querySelectorAll('button')).map((x) => x.textContent).join(' | ')}`);
      return b;
    },
    click: async (name) => {
      const b = h.button(name);
      await act(async () => {
        b.click();
      });
      await flush();
    },
    key: async (key, target) => {
      await act(async () => {
        (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true }));
      });
      await flush();
    },
    flush,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return h;
}
