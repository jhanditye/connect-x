// The real PracticeEngine: one per open phrase, behind the interface in trainer/engine.ts (the practice screen was built against
// the scripted FakeTrainerEngine, so state transitions, messages and snapshot rules follow it).
//
// It orchestrates the finished modules and owns no DSP of its own:
//   storage readAudio (phraseAnalysis.loadPhraseAudio)  ->  the phrase window, already padded by the segmenter
//   analyzePhraseCached                                 ->  the reference analysis (mix mode for mix clips)
//   audio/player preparePlayback / createPhrasePlayer   ->  the guide at the chosen speed and key; Listen, [You], [Both]
//   audio/duplex createDuplexSession                    ->  one context, route, count-in, stamped capture, interruptions
//   trainer/latency probeClicks                         ->  bleed and round-trip from the count-in clicks
//   analyzeInWorker, comparePhrase, buildFixes          ->  the score and the three fixes
//   PracticeSession.recordAttempt / get+setCalibration  ->  history, mastery and the review ladder (storage/library applyAttempt)
//
// Rules this file keeps:
//   - one exclusive operation at a time (`current`): a second Sing while one is starting, counting in, recording or analysing is ignored
//   - every await after which the world may have changed checks `alive(run)`; a stopped, interrupted or disposed run never reports
//   - audio is started inside the tap: duplex.prepare() is called before the first await of listen() / sing()
//   - dispose() releases the microphone, closes the context, aborts guide renders and clears every timer; later calls do nothing
//   - stop() cancels a take and says so; finish() ends a take that is being recorded and scores what was sung
//   - the microphone stays open IDLE_CLOSE_MS after a take so Try again is instant, shows as `micOpen`, and releaseMicrophone() closes it at once
//   - gated takes (no match, low evidence, sounds like the playback) are shown honestly and never counted toward mastery

import { analyzeInWorker } from '../analysis/client';
import { audibleTime, createDuplexSession, PRE_ROLL_SEC, takeIsUsable, type DuplexSession, type InterruptReason, type RouteInfo, type TakeResult } from '../audio/duplex';
import { floatToInt16 } from '../audio/pcm';
import { attemptBuffer, attemptStartForBoth, createPhrasePlayer, hearBothBuffer, preparePlayback, type PreparedPlayback } from '../audio/player';
import { RecorderError } from '../audio/recorder';
import { describeRoute, listInputDevices } from '../audio/route';
import { detectPitch } from '../dsp/pitch';
import { hzToMidi } from '../dsp/music';
import type { OpenPracticeFn, PracticeSession } from '../state/TrainerProvider';
import type { AnalysisOptions, KeyMode, PhraseComparison, PlayTiming, VoiceAnalysis } from '../types';
import { blockLevel, meterFraction } from '../ui/components/live';
import { loadTrainerPrefs, type TrainerPrefs } from '../ui/trainerPrefs';
import { comparePhrase, toneBiasFromCalibration } from './compare';
import type { PracticeEngine, PracticeOptions, PracticeResult, PracticeSnapshot, PracticeState } from './engine';
import { buildFixes } from './feedback';
import { probeClicks, type ClickProbe } from './latency';
import { analyzePhraseCached, loadPhraseAudio, PhraseAudioError, type PhraseAudio } from './phraseAnalysis';
import {
  blendLatency,
  buildAttemptRecord,
  COPY,
  COUNT_IN_BPM,
  countInDisplay,
  flavourOf,
  interruptionMessage,
  isAbort,
  judgeTake,
  medianOfRecent,
  microphoneMessage,
  octaveFold,
  reasonOf,
  SING_ALONG_TAIL_SEC,
  trimTake,
  type TrimmedTake,
} from './practiceSession';

/** Everything the engine reaches for outside itself; tests replace what they need. */
export interface PracticeEngineDeps {
  createSession?: () => DuplexSession;
  loadAudio?: typeof loadPhraseAudio;
  analyzePhrase?: typeof analyzePhraseCached;
  /** `signal` aborts when the take is cancelled: a worker that supports it stops the analysis instead of finishing for nobody. */
  analyzeAttempt?: (samples: Float32Array, sampleRate: number, opts: AnalysisOptions, signal?: AbortSignal) => Promise<VoiceAnalysis>;
  prepareGuide?: typeof preparePlayback;
  listDevices?: typeof listInputDevices;
  prefs?: () => TrainerPrefs;
  now?: () => number;
  makeId?: () => string;
  /** Wait after the last speed / key change before the new guide is rendered ahead of the next tap, ms. */
  prefetchDelayMs?: number;
  /** The microphone and the audio context are released after this long without a tap, ms. */
  idleCloseMs?: number;
  /** Live level and pitch refresh while a take runs, ms. */
  tickMs?: number;
}

const PREFETCH_DELAY_MS = 250;
/** How long the microphone stays open after a take (Try again is instant). Short, because the phone shows it as in use and a Bluetooth headset stays in call mode. */
const IDLE_CLOSE_MS = 30_000;
/** A Listen / hear-back waits this long for the audio context to run (a call or Siri can hold it) before it says what is wrong. */
const RESUME_GRACE_MS = 4000;
const TICK_MS = 50;
const MIN_RATE = 0.5;
const MAX_GUIDE_SHIFT = 12;
const MIN_LOOP_SEC = 0.1;
const LIVE_PITCH_WINDOW = 3;
/** Recent live readings are rounded to this many semitones so the snapshot is not replaced for noise. */
const LIVE_MIDI_STEP = 0.05;
const LIVE_LEVEL_STEP = 0.02;

const noop = (): void => undefined;
const STALE = Symbol('stale');
type Stale = typeof STALE;

type RunKind = 'listen' | 'take' | 'hear';

interface Run {
  readonly kind: RunKind;
  readonly abort: AbortController;
  /** Resolves with STALE when the run is ended for any reason; awaits are raced against it. */
  readonly stale: Promise<Stale>;
  readonly stops: (() => void)[];
  ended: boolean;
  /** The attempt is being saved: stop() no longer cancels, the result will show. */
  committed: boolean;
  /** A take only: ends the recording now and scores what there is (the Done button). Set once the take runs. */
  finish: (() => void) | null;
  /** finish() was called: the duplex's 'stopped' ending is a take to score, not a cancel. */
  finishing: boolean;
  /** Playhead in phrase seconds for position(). */
  position: (() => number) | null;
  resolveStale(): void;
}

interface LoadedAudio {
  /** What the singer hears and follows. */
  playback: PhraseAudio;
  /** What the reference was analysed from (the isolated vocal when the clip has one). */
  analysis: PhraseAudio;
}

interface LastTake {
  samples: Float32Array;
  sampleRate: number;
  mode: PracticeOptions['mode'];
  guide: PreparedPlayback;
  refStartSec: number | undefined;
  syncOffsetMs: number | null;
  matchedStartSec: number | null;
  refFirstNoteSec: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

function sameRoute(a: RouteInfo | null, b: RouteInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.inputLabel === b.inputLabel &&
    a.headphonesLikely === b.headphonesLikely &&
    a.labelsHidden === b.labelsHidden &&
    a.sampleRate === b.sampleRate &&
    a.inputSampleRate === b.inputSampleRate &&
    a.inputs.length === b.inputs.length &&
    a.inputs.every((d, i) => d.id === b.inputs[i].id && d.label === b.inputs[i].label)
  );
}

function sameOptions(a: PracticeOptions, b: PracticeOptions): boolean {
  return a.rate === b.rate && a.guideShift === b.guideShift && a.mode === b.mode && a.countInBeats === b.countInBeats && a.loop?.from === b.loop?.from && a.loop?.to === b.loop?.to && (a.loop === null) === (b.loop === null);
}

function defaultId(phraseId: string, at: number): string {
  const rand = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2, 10);
  return `${phraseId}-${at.toString(36)}-${rand}`;
}

/** The transposition hint for this take: the last good key, moved to the guide's key when a transposed guide is audible. */
function hintFor(keyHint: number | null, keyMode: KeyMode, guideShift: number): number | undefined {
  if (keyHint === null) return undefined;
  if (keyMode === 'locked' && guideShift !== 0) return guideShift + 12 * Math.round((keyHint - guideShift) / 12);
  return keyHint;
}

/**
 * comparePhrase with the remembered key as a hint; a hint that does not fit (the singer changed octave, or sang in a new key) is
 * dropped and the search run again without it, keeping the better of the two. A wrong hint is honoured by the comparison, so this
 * is what keeps a changed key from scoring as nonsense.
 */
function compareTake(attempt: VoiceAnalysis, ref: VoiceAnalysis, timing: PlayTiming, hint: number | undefined, guideShift: number, toneBias: ReturnType<typeof toneBiasFromCalibration>): PhraseComparison {
  // The speed the guide was played at: a take that follows a slowed guide runs 1 / rate times longer than the reference, and the scorer judges tempo against that.
  const guideRate = timing.rate;
  const first = comparePhrase(attempt, ref, timing, { transposeHint: hint, toneBias, guideShift, guideRate });
  if (hint === undefined || (first.score.status === 'ok' && first.coverage >= 0.6)) return first;
  const second = comparePhrase(attempt, ref, timing, { toneBias, guideShift, guideRate });
  const better = second.score.status === 'ok' && (first.score.status !== 'ok' || second.coverage > first.coverage + 0.1);
  return better ? second : first;
}

type AnalyzeAttempt = NonNullable<PracticeEngineDeps['analyzeAttempt']>;

/** analyzeInWorker takes the run's AbortSignal as its last parameter (after the progress callback): a cancelled take stops its analysis. */
const defaultAnalyzeAttempt: AnalyzeAttempt = (samples, sampleRate, opts, signal) => analyzeInWorker(samples, sampleRate, opts, undefined, signal);

export function createPracticeEngine(session: PracticeSession, deps: PracticeEngineDeps = {}): PracticeEngine {
  const { clip, phrase, store, settings } = session;
  const loadAudio = deps.loadAudio ?? loadPhraseAudio;
  const analyzePhrase = deps.analyzePhrase ?? analyzePhraseCached;
  const analyzeAttempt = deps.analyzeAttempt ?? defaultAnalyzeAttempt;
  const prepareGuide = deps.prepareGuide ?? preparePlayback;
  const listDevices = deps.listDevices ?? listInputDevices;
  const readPrefs = (): TrainerPrefs => {
    try {
      return (deps.prefs ?? loadTrainerPrefs)();
    } catch {
      return { defaultRate: 1, countInBeats: 3, startMode: 'auto', keepRecordings: false };
    }
  };
  const now = deps.now ?? Date.now;
  const makeId = deps.makeId ?? ((): string => defaultId(phrase.id, now()));
  const prefetchDelay = deps.prefetchDelayMs ?? PREFETCH_DELAY_MS;
  const idleCloseMs = deps.idleCloseMs ?? IDLE_CLOSE_MS;
  const tickMs = deps.tickMs ?? TICK_MS;

  const phraseDuration = Math.max(0.5, phrase.end - phrase.start);
  const analysisOptions: AnalysisOptions = { voiceType: settings.voiceType, a4Hz: settings.a4Hz };
  const flavour = flavourOf(clip.singerId);

  // ---------------------------------------------------------------------------------------------
  // State

  let disposed = false;
  let snapshot: PracticeSnapshot = {
    state: 'preparing',
    message: null,
    route: null,
    options: { rate: clamp(Number.isFinite(phrase.rate) ? round(phrase.rate, 2) : 1, MIN_RATE, 1), guideShift: 0, mode: 'turn-taking', countInBeats: clamp(readPrefs().countInBeats, 2, 4), loop: null },
    countIn: null,
    liveMidi: null,
    level: 0,
    reference: null,
    result: null,
    micOpen: false,
    speakerConfirmed: false,
  };
  const listeners = new Set<() => void>();

  let current: Run | null = null;
  let audio: LoadedAudio | null = null;
  let loadPromise: Promise<void> | null = null;
  const loadCtl = new AbortController();
  let duplex: DuplexSession | null = null;
  let offInterrupt: (() => void) | null = null;
  let memo: { key: string; prepared: PreparedPlayback } | null = null;
  let prefetchCtl: AbortController | null = null;
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastTake: LastTake | null = null;
  let keyHint: number | null = phrase.keyHint;
  /** The singer chose a mode (or the route did): the route probe at open no longer decides it. */
  let modeSettled = false;
  /** Sing-along was refused once for lack of headphones; choosing it again is the confirm tap. */
  let speakerWarned = false;
  let speakerOk = false;

  function setSpeakerOk(on: boolean): void {
    speakerOk = on;
    if (!on) speakerWarned = false;
    emit({ speakerConfirmed: on });
  }

  // ---------------------------------------------------------------------------------------------
  // Snapshot plumbing

  function emit(patch: Partial<PracticeSnapshot>): void {
    if (disposed && patch.state !== 'closed') return;
    let changed = false;
    for (const key of Object.keys(patch) as (keyof PracticeSnapshot)[]) {
      if (snapshot[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    snapshot = { ...snapshot, ...patch };
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A listener that throws must not stop the others.
      }
    }
  }

  const restState = (): PracticeState => (snapshot.result ? 'result' : 'idle');
  const calm = { countIn: null, liveMidi: null, level: 0 } as const;

  function setRoute(route: RouteInfo | null): void {
    if (!route || sameRoute(snapshot.route, route)) return;
    // Headphones plugged in or out: the earlier warning and the confirm tap belonged to the old route.
    if (snapshot.route && snapshot.route.headphonesLikely !== route.headphonesLikely) {
      speakerWarned = false;
      setSpeakerOk(false);
    }
    emit({ route });
  }

  // ---------------------------------------------------------------------------------------------
  // Runs

  function begin(kind: RunKind): Run {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (current) endRun(current);
    let resolveStale!: () => void;
    const stale = new Promise<Stale>((res) => (resolveStale = () => res(STALE)));
    const run: Run = { kind, abort: new AbortController(), stale, stops: [], ended: false, committed: false, finish: null, finishing: false, position: null, resolveStale };
    current = run;
    return run;
  }

  function endRun(run: Run): void {
    if (run.ended) return;
    run.ended = true;
    run.abort.abort();
    for (const stop of run.stops.splice(0)) {
      try {
        stop();
      } catch {
        // Already stopped.
      }
    }
    run.resolveStale();
    if (current === run) current = null;
    if (run.kind === 'take') stopTicker();
  }

  const alive = (run: Run): boolean => !disposed && current === run && !run.ended;
  const gone = (run: Run, value: unknown): boolean => value === STALE || !alive(run);

  /** Waits for `p`, but gives up (STALE) the moment the run ends. An abandoned `p` never reports an unhandled rejection. */
  function step<T>(run: Run, p: Promise<T>): Promise<T | Stale> {
    p.catch(noop);
    return Promise.race([p, run.stale]);
  }

  /** The run failed: the state says what happened and the message names the next step. */
  function fail(run: Run, state: 'error' | 'interrupted', message: string): void {
    if (!alive(run)) return;
    endRun(run);
    emit({ state, message, ...calm });
    armIdle();
  }

  /** The run finished normally: back to the resting state. */
  function settle(run: Run, patch: Partial<PracticeSnapshot> = {}): void {
    if (!alive(run)) return;
    endRun(run);
    emit({ state: restState(), message: null, ...calm, ...patch });
    armIdle();
  }

  // ---------------------------------------------------------------------------------------------
  // The audio session

  function ensureDuplex(): DuplexSession {
    if (duplex) return duplex;
    const d = (deps.createSession ?? createDuplexSession)();
    duplex = d;
    offInterrupt = d.onInterrupted((reason) => onInterrupted(d, reason));
    return d;
  }

  function releaseDuplex(): void {
    const d = duplex;
    if (!d) return;
    duplex = null;
    offInterrupt?.();
    offInterrupt = null;
    d.close().catch(noop);
    emit({ micOpen: false });
  }

  /** The microphone is open when the session has an analyser (it exists only while the stream is attached). */
  const micIsOpen = (): boolean => {
    try {
      return !!duplex && !!duplex.analyser;
    } catch {
      return false;
    }
  };

  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    emit({ micOpen: micIsOpen() });
    if (disposed || !duplex || current) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (!disposed && !current) releaseDuplex();
    }, idleCloseMs);
  }

  function onInterrupted(d: DuplexSession, reason: InterruptReason): void {
    if (disposed || d !== duplex) return;
    if (reason === 'device-change') {
      d.refreshRoute().then((r) => {
        if (!disposed && d === duplex) setRoute(r);
      }, noop);
    }
    const run = current;
    if (!run || run.kind === 'take') return; // a take reports its own interruption with its result
    if (reason === 'mic-ended' || reason === 'no-audio') return; // playback does not use the microphone
    endRun(run);
    emit({ state: 'interrupted', message: interruptionMessage(reason, 'playback'), ...calm });
    armIdle();
  }

  // ---------------------------------------------------------------------------------------------
  // Loading the phrase

  function ensureLoaded(): Promise<void> {
    if (audio && snapshot.reference) return Promise.resolve();
    if (loadPromise) return loadPromise;
    const p = (async (): Promise<void> => {
      const playback = await loadAudio(store, clip, phrase, 'mix');
      const analysis = clip.audio.vocal ? await loadAudio(store, clip, phrase, 'vocal') : playback;
      const reference = await analyzePhrase(clip, phrase, analysis, analysisOptions, loadCtl.signal);
      if (disposed) return;
      audio = { playback, analysis };
      emit({ reference, ...(snapshot.state === 'preparing' && !current ? { state: 'idle' as const, message: null } : {}) });
    })();
    loadPromise = p;
    const clear = (): void => {
      if (loadPromise === p) loadPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  function loadMessage(err: unknown): string {
    return err instanceof PhraseAudioError ? err.message : COPY.openFailed(reasonOf(err));
  }

  /** The route as far as it is known before the microphone is allowed (names are hidden until then). */
  async function probeRoute(): Promise<void> {
    try {
      const devices = await listDevices();
      if (disposed || !devices || snapshot.route) return;
      const route = describeRoute(devices.map((d) => ({ kind: 'audioinput' as const, deviceId: d.id, label: d.label })), '', 0, null);
      emit({ route });
      if (!modeSettled && route.headphonesLikely && !route.labelsHidden) emit({ options: { ...snapshot.options, mode: 'sing-along' } });
    } catch {
      // The route is only a hint at this point.
    }
  }

  /**
   * Headphones plugged in or out while no audio session is open (before the first tap, after a refusal, after the microphone was
   * let go): the device list is read again, so the screen asks about headphones from what is true now. An open session does its own.
   */
  async function refreshRouteFromList(): Promise<void> {
    if (duplex) return;
    try {
      const devices = await listDevices();
      if (disposed || duplex || !devices) return;
      const labels = devices.map((d) => ({ kind: 'audioinput' as const, deviceId: d.id, label: d.label }));
      const fresh = describeRoute(labels, snapshot.route?.inputLabel ?? '', snapshot.route?.sampleRate ?? 0, snapshot.route?.inputSampleRate ?? null);
      // A list read while labels are hidden again must not erase names that were known.
      if (fresh.labelsHidden && snapshot.route && !snapshot.route.labelsHidden) return;
      setRoute(fresh);
    } catch {
      // The route stays as it was.
    }
  }
  const mediaDevices = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  const onDeviceChange = (): void => void refreshRouteFromList();

  // ---------------------------------------------------------------------------------------------
  // The guide

  const guideKey = (ctx: Pick<AudioContext, 'sampleRate'>, o: PracticeOptions): string => `${ctx.sampleRate}|${round(o.rate, 3)}|${round(o.guideShift, 2)}`;
  const guideReady = (ctx: Pick<AudioContext, 'sampleRate'> | null, o: PracticeOptions): boolean => !!ctx && memo?.key === guideKey(ctx, o);

  async function guideFor(ctx: AudioContext, o: PracticeOptions, signal: AbortSignal): Promise<PreparedPlayback> {
    const key = guideKey(ctx, o);
    if (memo?.key === key) return memo.prepared;
    if (!audio) throw new Error('The phrase is not loaded yet.');
    const prepared = await prepareGuide(ctx, audio.playback, o.rate, o.guideShift, { signal });
    if (!disposed && !signal.aborted) memo = { key, prepared };
    return prepared;
  }

  function contextOf(d: DuplexSession | null): AudioContext | null {
    try {
      return d ? d.context : null;
    } catch {
      return null;
    }
  }

  /** A speed or key change: render the new guide ahead of the next tap, once the singer has stopped tapping chips. */
  function schedulePrefetch(): void {
    clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
    prefetchCtl?.abort(); // whatever was being prepared is stale now
    prefetchCtl = null;
    if (disposed || !duplex || !audio) return;
    prefetchTimer = setTimeout(() => {
      prefetchTimer = undefined;
      void runPrefetch();
    }, prefetchDelay);
  }

  async function runPrefetch(): Promise<void> {
    const ctx = contextOf(duplex);
    if (disposed || !ctx || !audio || current?.kind === 'take') return;
    const o = snapshot.options;
    if (guideReady(ctx, o)) return;
    const ctl = new AbortController();
    prefetchCtl = ctl;
    try {
      await guideFor(ctx, o, ctl.signal);
    } catch {
      // The tap that needs the guide asks again and says what went wrong.
    } finally {
      if (prefetchCtl === ctl) prefetchCtl = null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Playback (Listen, [Original], [You], [Both])

  /**
   * Resolves true once the audio context is running, false after RESUME_GRACE_MS without it. A call, Siri or another app can hold
   * the context (iOS 'interrupted', or a resume() that never settles); without this the screen would show "playing" in silence.
   */
  function waitRunning(run: Run, ctx: AudioContext): Promise<boolean> {
    if (String(ctx.state) === 'running') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        try {
          ctx.removeEventListener('statechange', onState);
        } catch {
          // Already gone.
        }
        resolve(ok);
      };
      const onState = (): void => {
        if (String(ctx.state) === 'running') finish(true);
      };
      try {
        ctx.addEventListener('statechange', onState);
      } catch {
        // No events: the timeout still decides.
      }
      timer = setTimeout(() => finish(String(ctx.state) === 'running'), RESUME_GRACE_MS);
      run.stops.push(() => finish(false));
    });
  }

  /** Plays `source` under `run` and resolves when it ends or is stopped. */
  function playUnder(run: Run, ctx: AudioContext, source: AudioBuffer | PreparedPlayback, opts: { rate?: number; from?: number; to?: number; loop?: boolean; phraseTime: boolean }): Promise<void> {
    return new Promise<void>((resolve) => {
      const p = createPhrasePlayer(ctx, source, { rate: opts.rate });
      run.stops.push(() => p.dispose());
      run.position = opts.phraseTime ? () => p.position() : () => NaN;
      emit({ state: 'listening', message: null, ...calm });
      p.play({
        from: opts.from,
        to: opts.to,
        loop: opts.loop,
        onEnded: () => {
          resolve();
          settle(run);
        },
      });
    });
  }

  async function listen(): Promise<void> {
    if (disposed || current?.kind === 'take') return;
    const run = begin('listen');
    const opts = { ...snapshot.options };
    const d = ensureDuplex();
    let prepared: Promise<RouteInfo>;
    try {
      prepared = d.prepare({ mic: false }); // inside the tap, before any await
    } catch (e) {
      prepared = Promise.reject(e);
    }
    prepared.catch(noop);
    try {
      if ((!audio || !snapshot.reference) && !snapshot.result) emit({ state: 'preparing', message: null, ...calm });
      const loaded = await step(run, ensureLoaded().catch((e: unknown) => Promise.reject(Object.assign(new Error(loadMessage(e)), { stage: 'load' }))));
      if (gone(run, loaded)) return;
      const route = await step(run, prepared);
      if (gone(run, route)) return;
      setRoute(route as RouteInfo);
      const ctx = d.context;
      if (!guideReady(ctx, opts) && !snapshot.result) emit({ state: 'preparing', message: null, ...calm });
      const guide = await step(run, guideFor(ctx, opts, run.abort.signal));
      if (gone(run, guide)) return;
      const running = await step(run, waitRunning(run, ctx));
      if (gone(run, running)) return;
      if (running !== true) return fail(run, 'interrupted', COPY.audioBusy);
      await playUnder(run, ctx, guide as PreparedPlayback, { from: opts.loop?.from, to: opts.loop?.to, loop: !!opts.loop, phraseTime: true });
    } catch (err) {
      if (!alive(run)) return;
      if ((err as { stage?: string }).stage === 'load') return fail(run, 'error', reasonOf(err));
      if (err instanceof RecorderError) return fail(run, 'error', err.message);
      if (isAbort(err)) return settle(run);
      fail(run, 'error', COPY.guideFailed(reasonOf(err)));
    }
  }

  async function playAttempt(which: 'original' | 'you' | 'both'): Promise<void> {
    if (disposed || current?.kind === 'take') return;
    if (which === 'original') return listen();
    const take = lastTake;
    if (!take) return;
    const run = begin('hear');
    const d = ensureDuplex();
    let prepared: Promise<RouteInfo>;
    try {
      prepared = d.prepare({ mic: false });
    } catch (e) {
      prepared = Promise.reject(e);
    }
    prepared.catch(noop);
    try {
      const route = await step(run, prepared);
      if (gone(run, route)) return;
      setRoute(route as RouteInfo);
      const ctx = d.context;
      const running = await step(run, waitRunning(run, ctx));
      if (gone(run, running)) return;
      if (running !== true) return fail(run, 'interrupted', COPY.audioBusy);
      if (which === 'you') {
        await playUnder(run, ctx, attemptBuffer(ctx, { samples: take.samples, sampleRate: take.sampleRate }), { rate: 1, phraseTime: false });
      } else {
        const t0 = attemptStartForBoth({ mode: take.mode, refStartInCaptureSec: take.refStartSec ?? null, syncOffsetMs: take.syncOffsetMs, matchedStartSec: take.matchedStartSec, refFirstNoteSec: take.refFirstNoteSec, rate: take.guide.rate });
        const both = hearBothBuffer(ctx, take.guide, { samples: take.samples, sampleRate: take.sampleRate }, t0);
        await playUnder(run, ctx, both, { rate: take.guide.rate, phraseTime: true });
      }
    } catch (err) {
      const message = err instanceof RecorderError ? err.message : COPY.playbackFailed(reasonOf(err));
      if (alive(run)) settle(run);
      throw new Error(message);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A take

  function stopTicker(): void {
    if (ticker !== undefined) clearInterval(ticker);
    ticker = undefined;
  }

  interface Timeline {
    startCtx: number;
    beats: number;
    beatSec: number;
    guideStartCtx: number;
    guideEndCtx: number;
    mode: PracticeOptions['mode'];
  }

  function startTicker(run: Run, d: DuplexSession, ctx: AudioContext, tl: Timeline, target: number | null): void {
    stopTicker();
    const analyser = d.analyser;
    const buf = analyser ? new Float32Array(analyser.fftSize) : null;
    const recent: (number | null)[] = [];
    const a4 = settings.a4Hz;
    ticker = setInterval(() => {
      if (!alive(run)) return stopTicker();
      try {
        const t = ctx.currentTime;
        if (t < tl.guideStartCtx) {
          emit({ state: 'countin', countIn: countInDisplay(t - tl.startCtx, tl.beats, PRE_ROLL_SEC, tl.beatSec), liveMidi: null, level: 0 });
          return;
        }
        if (tl.mode === 'turn-taking' && t < tl.guideEndCtx) {
          emit({ state: 'listening', countIn: null, liveMidi: null, level: 0 });
          return;
        }
        let level = 0;
        let live: number | null = null;
        if (analyser && buf) {
          analyser.getFloatTimeDomainData(buf);
          const { rmsDb } = blockLevel(buf);
          level = round(meterFraction(rmsDb), 2);
          level = Math.round(level / LIVE_LEVEL_STEP) * LIVE_LEVEL_STEP;
          const pitch = rmsDb > -60 ? detectPitch(buf, ctx.sampleRate, 70, 1100) : null;
          recent.push(pitch ? hzToMidi(pitch.hz, a4) : null);
          if (recent.length > LIVE_PITCH_WINDOW) recent.shift();
          const m = medianOfRecent(recent);
          if (m !== null && Number.isFinite(m)) live = Math.round((target === null ? m : octaveFold(m, target)) / LIVE_MIDI_STEP) * LIVE_MIDI_STEP;
        }
        emit({ state: 'singing', countIn: null, liveMidi: live, level: round(level, 2) });
      } catch {
        // A reading that fails is skipped; the take itself is unaffected.
      }
    }, tickMs);
  }

  /** Sing along needs headphones and there are none: say so, switch to listen-then-sing, and start nothing. The microphone is not kept open for it. */
  function refuseSingAlong(): void {
    speakerWarned = true;
    modeSettled = true;
    emit({ state: restState(), message: COPY.noSpeaker, options: { ...snapshot.options, mode: 'turn-taking' }, ...calm });
    releaseDuplex();
  }

  async function sing(confirm?: { speakerConfirmed?: boolean }): Promise<void> {
    if (disposed || current?.kind === 'take') return; // a double tap while a take is starting, running or being analysed
    if (confirm?.speakerConfirmed && snapshot.options.mode === 'sing-along') setSpeakerOk(true);
    // The route names are known (not hidden): the refusal needs no microphone, so none is opened for it.
    const known = snapshot.route;
    if (snapshot.options.mode === 'sing-along' && known && !known.labelsHidden && !known.headphonesLikely && !speakerOk) {
      if (current) endRun(current);
      clearTimeout(idleTimer);
      refuseSingAlong();
      return;
    }
    const run = begin('take');
    const opts = { ...snapshot.options };
    const d = ensureDuplex();
    let micReady: Promise<RouteInfo>;
    try {
      micReady = d.prepare({ mic: true }); // inside the tap, before any await: iOS starts audio and asks for the microphone here
    } catch (e) {
      micReady = Promise.reject(e);
    }
    micReady.catch(noop);
    emit({ state: 'preparing', message: null, ...calm });

    // ---- ready: phrase, microphone, route, guide
    let route: RouteInfo;
    let guide: PreparedPlayback;
    let calibration: Record<string, number> = {};
    try {
      const loaded = await step(run, ensureLoaded().catch((e: unknown) => Promise.reject(Object.assign(new Error(loadMessage(e)), { stage: 'load' }))));
      if (gone(run, loaded)) return;
      const r = await step(run, micReady);
      if (gone(run, r)) return;
      route = r as RouteInfo;
    } catch (err) {
      if (!alive(run)) return;
      if ((err as { stage?: string }).stage === 'load') return fail(run, 'error', reasonOf(err));
      return fail(run, 'error', microphoneMessage(err));
    }
    setRoute(route);

    if (opts.mode === 'sing-along' && !route.headphonesLikely && !speakerOk) {
      // The speaker would leak into the microphone and the score could measure the playback: listen-then-sing instead, and say so.
      // (Only reached when the names were hidden until the microphone was allowed; the microphone is released again.)
      if (!alive(run)) return;
      endRun(run);
      refuseSingAlong();
      return;
    }
    emit({ micOpen: micIsOpen() });
    const mode = opts.mode === 'sing-along' && (route.headphonesLikely || speakerOk) ? 'sing-along' : 'turn-taking';

    try {
      const ctx = d.context;
      if (!guideReady(ctx, opts)) emit({ state: 'preparing', message: null, ...calm });
      const g = await step(run, guideFor(ctx, opts, run.abort.signal));
      if (gone(run, g)) return;
      guide = g as PreparedPlayback;
      const cal = await step(run, session.getCalibration().catch((): Record<string, number> => ({})));
      if (gone(run, cal)) return;
      calibration = cal as Record<string, number>;
    } catch (err) {
      if (!alive(run)) return;
      return isAbort(err) ? settle(run) : fail(run, 'error', COPY.guideFailed(reasonOf(err)));
    }

    // ---- the take
    const ctx = d.context;
    const beats = opts.countInBeats;
    const beatSec = 60 / COUNT_IN_BPM;
    const startCtx = ctx.currentTime;
    const guideStartCtx = startCtx + PRE_ROLL_SEC + beats * beatSec;
    const timeline: Timeline = { startCtx, beats, beatSec, guideStartCtx, guideEndCtx: guideStartCtx + guide.buffer.duration, mode };
    let handle: ReturnType<DuplexSession['runTake']>;
    try {
      handle = d.runTake(guide.buffer, {
        mode,
        countInBeats: beats,
        bpm: COUNT_IN_BPM,
        tailSec: SING_ALONG_TAIL_SEC,
        gain: 1,
        turnSec: guide.buffer.duration * 1.2 + 1.5,
      });
    } catch (err) {
      return fail(run, 'error', microphoneMessage(err));
    }
    run.stops.push(() => handle.stop());
    run.finish = () => {
      run.finishing = true;
      handle.stop();
    };
    lastTake = null;
    // The playhead is where the guide is (count-in and the singer's own turn: nothing to show).
    run.position = () => {
      const t = audibleTime(ctx) - guideStartCtx;
      const p = t * guide.rate;
      return t >= 0 && p <= phraseDuration + 0.05 ? Math.min(p, phraseDuration) : NaN;
    };
    const refMedian = snapshot.reference?.pitch.medianMidi ?? null;
    emit({ state: 'countin', countIn: beats, result: null, message: null, liveMidi: null, level: 0 });
    startTicker(run, d, ctx, timeline, refMedian === null ? null : refMedian + opts.guideShift);

    const take = await handle.done;
    stopTicker();
    if (!alive(run)) return;

    if (take.endedBy === 'interrupted') return fail(run, 'interrupted', interruptionMessage(take.interruptedBy, 'take'));
    if (take.endedBy === 'stopped' && !run.finishing) return settle(run); // stopped by something other than stop() or finish(): nothing to score
    if (!takeIsUsable(take)) return fail(run, 'interrupted', take.samples.length === 0 ? COPY.empty : COPY.gap);

    emit({ state: 'processing', ...calm });
    try {
      await finishTake(run, take, { mode, opts, guide, route, calibration });
    } catch (err) {
      if (alive(run)) fail(run, 'error', COPY.analysisFailed(reasonOf(err)));
    }
  }

  interface TakePlan {
    mode: PracticeOptions['mode'];
    opts: PracticeOptions;
    guide: PreparedPlayback;
    route: RouteInfo;
    calibration: Record<string, number>;
  }

  /** Analyse, compare, judge, save and show one finished take. Throws on a failure the caller turns into an error state. */
  async function finishTake(run: Run, take: TakeResult, plan: TakePlan): Promise<void> {
    const { mode, opts, guide, route, calibration } = plan;
    const reference = snapshot.reference;
    if (!reference) throw new Error('the reference phrase is missing');
    const trimmed: TrimmedTake = trimTake(take, mode);
    const probe: ClickProbe | null = take.clickTimesInCaptureSec.length > 0 ? probeClicks(take.samples, take.sampleRate, take.clickTimesInCaptureSec) : null;

    const analysed = await step(run, analyzeAttempt(trimmed.samples, trimmed.sampleRate, analysisOptions, run.abort.signal));
    if (gone(run, analysed)) return;
    const attemptAnalysis = analysed as VoiceAnalysis;

    const keyMode: KeyMode = mode === 'sing-along' ? 'locked' : 'free';
    const latencyMs = probe && probe.consistent && probe.roundTripMs !== null ? probe.roundTripMs : undefined;
    const timing: PlayTiming = { mode, rate: guide.rate, refStartInCaptureSec: trimmed.refStartSec, keyMode, latencyMs };
    const compared = compareTake(attemptAnalysis, reference, timing, hintFor(keyHint, keyMode, opts.guideShift), opts.guideShift, toneBiasFromCalibration(calibration));
    const verdict = judgeTake({ comparison: compared, mode, probe, headphonesLikely: route.headphonesLikely, keyHint, voicedSec: attemptAnalysis.voicedSec, referenceUsable: reference.notes.length >= 2 && reference.voicedSec >= 1 });
    const comparison = verdict.comparison;
    const fixes = verdict.countable ? buildFixes(comparison, flavour) : [];
    const at = now();
    const attempt = buildAttemptRecord({
      id: makeId(),
      at,
      clipId: clip.id,
      phraseId: phrase.id,
      mode,
      keyMode,
      rate: guide.rate,
      comparison,
      routeKind: route.kind,
      style: attemptAnalysis.style,
      fixes,
    });

    // ---- commit point: from here a stop() no longer cancels, the attempt is being saved
    if (!alive(run)) return;
    run.committed = true;
    let saved = false;
    let notice = verdict.notice;
    let hasAudio = false;
    if (verdict.countable) {
      const keep = readPrefs().keepRecordings;
      const recording = keep && trimmed.samples.length > 0 ? { pcm: floatToInt16(trimmed.samples), sampleRate: trimmed.sampleRate } : undefined;
      try {
        const r = await session.recordAttempt(attempt, recording);
        saved = r.saved;
        hasAudio = r.saved && !!recording && !r.notice;
        if (r.saved) keyHint = r.phrase.keyHint;
        if (r.notice) notice = notice ? `${notice} ${r.notice}` : r.notice;
      } catch (err) {
        notice = notice ? `${notice} ${COPY.notSaved(reasonOf(err))}` : COPY.notSaved(reasonOf(err));
      }
    }
    if (!alive(run)) return;

    lastTake = {
      samples: trimmed.samples,
      sampleRate: trimmed.sampleRate,
      mode,
      guide,
      refStartSec: trimmed.refStartSec,
      syncOffsetMs: comparison.syncOffsetMs,
      matchedStartSec: comparison.score.matchedSpan?.start ?? null,
      refFirstNoteSec: reference.notes[0]?.start ?? 0,
    };
    const result: PracticeResult = { comparison, fixes, attempt: { ...attempt, hasAudio }, saved, notice, keyMode };
    endRun(run);
    emit({ state: 'result', result, message: null, ...calm });
    armIdle();

    // What the click probe learned about this route is remembered for next time (not awaited: the result is already on screen).
    if (probe && probe.consistent && probe.roundTripMs !== null && route.kind !== 'unknown') {
      session.setCalibration(route.kind, blendLatency(calibration[route.kind], probe.roundTripMs)).catch(noop);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The public engine

  function setOptions(patch: Partial<PracticeOptions>): void {
    if (disposed) return;
    const cur = snapshot.options;
    const next: PracticeOptions = { ...cur };
    if (typeof patch.rate === 'number' && Number.isFinite(patch.rate)) next.rate = clamp(round(patch.rate, 2), MIN_RATE, 1);
    if (typeof patch.guideShift === 'number' && Number.isFinite(patch.guideShift)) next.guideShift = clamp(Math.round(patch.guideShift), -MAX_GUIDE_SHIFT, MAX_GUIDE_SHIFT);
    if (patch.mode === 'sing-along' || patch.mode === 'turn-taking') {
      next.mode = patch.mode;
      modeSettled = true;
      if (patch.mode === 'sing-along' && speakerWarned) setSpeakerOk(true); // choosing it again after the warning is the confirm tap
    }
    if (typeof patch.countInBeats === 'number' && Number.isFinite(patch.countInBeats)) next.countInBeats = clamp(Math.round(patch.countInBeats), 2, 4);
    if (patch.loop !== undefined) {
      const l = patch.loop;
      if (l && Number.isFinite(l.from) && Number.isFinite(l.to)) {
        const from = clamp(l.from, 0, phraseDuration);
        const to = clamp(l.to, 0, phraseDuration);
        next.loop = to - from >= MIN_LOOP_SEC ? { from, to } : null;
      } else next.loop = null;
    }
    if (sameOptions(cur, next)) return;
    emit({ options: next });
    if (next.rate !== cur.rate || next.guideShift !== cur.guideShift) schedulePrefetch();
  }

  /** Stops the guide, or cancels a take (before it is scored) and says so, so the screen is never left looking as if nothing happened. */
  function stop(): void {
    if (disposed) return;
    const run = current;
    if (!run || run.committed) return;
    const wasTake = run.kind === 'take';
    endRun(run);
    emit({ state: restState(), message: wasTake ? COPY.cancelled : null, ...calm });
    armIdle();
  }

  /** The Done button: while recording, end the take now and score what was sung. Anywhere else it is stop(). */
  function finish(): void {
    if (disposed) return;
    const run = current;
    if (run && !run.committed && !run.ended && run.kind === 'take' && run.finish && snapshot.state === 'singing') {
      run.finish();
      return;
    }
    stop();
  }

  /** Turns the microphone and the audio context off now (the "Turn off" button). Does nothing while a guide plays or a take runs. */
  function releaseMicrophone(): void {
    if (disposed || current) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
    releaseDuplex();
  }

  function dispose(): void {
    if (disposed) return;
    const run = current;
    disposed = true;
    current = null;
    if (run) endRun(run);
    clearTimeout(prefetchTimer);
    clearTimeout(idleTimer);
    stopTicker();
    prefetchCtl?.abort();
    prefetchCtl = null;
    loadCtl.abort();
    memo = null;
    lastTake = null;
    try {
      mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    } catch {
      // Already gone.
    }
    releaseDuplex();
    emit({ state: 'closed', countIn: null, liveMidi: null, level: 0 });
    listeners.clear();
  }

  // The reference and the route load in the background; Listen and Sing wait for them (and retry a failed load).
  void probeRoute();
  try {
    mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  } catch {
    // No device events here: the route is read at each Sing.
  }
  ensureLoaded().catch((err: unknown) => {
    if (disposed || isAbort(err) || current) return;
    emit({ state: 'error', message: loadMessage(err) });
  });

  return {
    clip,
    phrase,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      if (disposed) return noop;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    position(): number {
      if (disposed || !current?.position) return NaN;
      try {
        return current.position();
      } catch {
        return NaN;
      }
    },
    setOptions,
    listen,
    sing,
    stop,
    finish,
    releaseMicrophone,
    playAttempt,
    dispose,
  };
}

/** The factory TrainerProvider takes as `openPractice`: one real engine per open phrase. */
export const openPractice: OpenPracticeFn = (session) => Promise.resolve(createPracticeEngine(session));
