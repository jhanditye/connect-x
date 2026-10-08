// ONE AudioContext for the guide playback, the count-in clicks and the microphone capture, so every sample has a position on
// the same clock. The capture worklet stamps each batch with its AudioWorkletGlobalScope.currentFrame (Safari 14.5+), which
// turns "when did I schedule the guide" into an exact index in the recording. What is NOT known is the hardware latency
// (output + input): trainer/compare.ts estimates the sync offset from the singing itself, and trainer/latency.ts reads the
// round trip from the count-in clicks.
//
// Lifecycle: createDuplexSession() -> prepare() inside the tap (starts the context; with `mic` also asks for the microphone)
// -> listen() / runTake() any number of times -> close() (always: stops the microphone, closes the context, resets the audio
// session so other apps' audio comes back). Interruptions (phone call, app hidden, microphone ended, route change) end the
// running take as 'interrupted' and are announced through onInterrupted().

import type { PlayMode } from '../types';
import { loadMicChoice } from './micChoice';
import { microphoneUnavailableReason, RecorderError, toRecorderError } from './recorder';
import { classifyRoute, describeRoute, listInputDevices } from './route';

export { classifyRoute };

export type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

export interface RouteInfo {
  inputLabel: string;
  inputs: { id: string; label: string }[];
  kind: 'wired' | 'bluetooth' | 'builtin' | 'unknown';
  /** A wired or Bluetooth input is present (a guess: iOS does not say where the sound goes). */
  headphonesLikely: boolean;
  /** The audio context's rate. */
  sampleRate: number;
  /** The rate the microphone track reports (8 to 16 kHz for a Bluetooth voice profile); null when unknown. */
  inputSampleRate?: number | null;
  /** The browser hides input names until a microphone was allowed once: kind is 'unknown' because of that, not the hardware. */
  labelsHidden?: boolean;
}

export type InterruptReason = 'audio-session' | 'hidden' | 'mic-ended' | 'device-change' | 'no-audio';

export interface TakeResult {
  samples: Float32Array;
  sampleRate: number;
  /** Sing-along only: where the guide's first sample was scheduled in the recording's clock, seconds. null in turn-taking. */
  refStartInCaptureSec: number | null;
  clickTimesInCaptureSec: number[];
  /** Where the guide's last sample was scheduled. Turn-taking: the part of the recording before this is the guide leaking in, not the singer. */
  guideEndInCaptureSec?: number | null;
  /** Capture frames that went missing (the audio thread glitched): padded with silence so the clock stays right. See takeIsUsable(). */
  droppedFrames: number;
  endedBy: 'finished' | 'stopped' | 'interrupted';
  /** Why a take ended as 'interrupted'. */
  interruptedBy?: InterruptReason | null;
  /** false when the browser has no AudioWorklet and frames were counted instead of stamped: the schedule is only about right (the sync estimate absorbs the offset). */
  clockExact?: boolean;
}

export interface TakeOptions {
  mode: PlayMode;
  countInBeats: number;
  bpm: number;
  tailSec: number;
  gain: number;
  /**
   * Click times in seconds after the room-tone pause, instead of `countInBeats` clicks one beat apart (the guide then starts one
   * beat after the last). The click test uses an uneven pattern so a steady beat or hum in the room cannot pass for the clicks.
   */
  clickOffsetsSec?: number[];
  /** Peak level of the count-in clicks, 0..1 (default 0.4). */
  clickGain?: number;
  /** Turn-taking: how long the singer's turn lasts after the guide, seconds (default: the guide's length plus 1.5 s). */
  turnSec?: number;
}

export interface ListenOptions {
  from?: number;
  to?: number;
  loop?: boolean;
  onEnded?: () => void;
}

export interface DuplexSession {
  readonly context: AudioContext;
  /**
   * Starts the audio context (call inside the tap) and, with `mic`, opens the microphone. Safe to call again: listen-only first,
   * then with the microphone on the first Sing tap. A different `deviceId` switches microphones. Rejects with a RecorderError
   * (denied / unsupported / no-device) whose message names what to do.
   */
  prepare(opts: { mic: boolean; deviceId?: string }): Promise<RouteInfo>;
  /** Plays the guide (no microphone involved). One playback at a time; `stop()` is idempotent; `onEnded` fires once. */
  listen(buffer: AudioBuffer, opts: ListenOptions): { stop(): void; position(): number };
  runTake(buffer: AudioBuffer, opts: TakeOptions): { done: Promise<TakeResult>; stop(): void };
  onInterrupted(cb: (reason: InterruptReason) => void): () => void;
  /** For the level meter and live pitch; null until the microphone is open. */
  readonly analyser: AnalyserNode | null;
  readonly route: RouteInfo | null;
  /** Frames of microphone audio held right now (bounded while idle; for diagnostics and leak tests). */
  readonly bufferedFrames: number;
  /** Reads the device list again (after a devicechange). */
  refreshRoute(): Promise<RouteInfo | null>;
  /** Tries to get a stopped context running again. Call inside a tap; resolves whether it is running. */
  resume(): Promise<boolean>;
  close(): Promise<void>;
}

/** A glitch up to this long is padded with silence and harmless (one analysis hop is 10 ms); more than that and the take is thrown away. */
export const MAX_DROPPED_SEC = 0.02;

/**
 * Whether a take can be scored: it ran to its end (or was stopped on purpose), has audio, and lost no more than
 * MAX_DROPPED_SEC of it. Interrupted takes and takes with nothing in them are never usable.
 */
export function takeIsUsable(r: Pick<TakeResult, 'endedBy' | 'samples' | 'sampleRate' | 'droppedFrames'>): boolean {
  return r.endedBy !== 'interrupted' && r.samples.length > 0 && r.droppedFrames <= MAX_DROPPED_SEC * r.sampleRate;
}

/** navigator.audioSession (Safari 16.4+). Missing elsewhere: then the call does nothing. */
export function setAudioSessionType(type: AudioSessionType): boolean {
  const nav = globalThis.navigator as unknown as { audioSession?: { type: AudioSessionType } } | undefined;
  if (!nav?.audioSession) return false;
  try {
    nav.audioSession.type = type;
    return true;
  } catch {
    return false;
  }
}

// The capture worklet. Each batch is posted with the frame number of its first sample; batches are flushed on request so the
// last partial batch of a take is not lost, and a jump in currentFrame (the audio thread glitched) closes the batch so the
// gap shows up as a gap between batches, which the take counts as dropped frames.
const WORKLET = `
class MimicStamp extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.start = 0; this.port.onmessage = (e) => { if (e.data === 'flush') this.flush(); }; }
  flush() { if (this.n > 0) { const d = this.buf.slice(0, this.n); this.port.postMessage({ f: this.start, d }, [d.buffer]); this.n = 0; } this.port.postMessage('flushed'); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    const len = ch ? ch.length : 128;
    if (this.n > 0 && currentFrame !== this.start + this.n) this.flush2(); // a gap in the render clock: start a new batch at the new frame
    if (this.n === 0) this.start = currentFrame;
    if (this.n + len > this.buf.length) this.flush2();
    if (ch) this.buf.set(ch, this.n); else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    return true;
  }
  flush2() { const d = this.buf.slice(0, this.n); this.port.postMessage({ f: this.start, d }, [d.buffer]); this.n = 0; this.start = currentFrame; }
}
registerProcessor('mimic-stamp', MimicStamp);
`;

interface Chunk {
  frame: number;
  data: Float32Array;
}

export interface DuplexTestHooks {
  /** Chromium test only: also feed the playback into the capture worklet (a zero-latency loopback). */
  loopback?: boolean;
  /** Test the ScriptProcessor fallback as if the browser had no AudioWorklet. */
  noWorklet?: boolean;
  /** Called for every captured batch (first frame, length), to look for gaps. */
  onChunk?: (frame: number, length: number) => void;
}

/** Silence before the first click: the count-in's own room-tone window for the click probe. */
export const PRE_ROLL_SEC = 0.45;
/** Capture audio kept while no take runs (the microphone stays open between attempts). */
const IDLE_KEEP_SEC = 1.5;
/** Nothing arrived from the microphone this long after a take started: Safari did not deliver audio. */
const NO_AUDIO_MS = 2000;
/** The audio clock did not move for this long during a take: the context is stalled (interruption without an event). */
const STALL_MS = 1500;
const RESUME_WAIT_MS = 1500;
const FLUSH_WAIT_MS = 250;
const SCRIPT_BUFFER = 4096;

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

const wall = (): number => Date.now();

/** The context time the speaker is playing right now: output latency included where the browser says it (Safari 14.5+). */
export function audibleTime(c: Pick<AudioContext, 'currentTime' | 'getOutputTimestamp'>): number {
  try {
    const ts = c.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.contextTime > 0) return ts.contextTime;
  } catch {
    // Not implemented for this state.
  }
  return c.currentTime;
}

/** Resolves with the promise's value, or undefined after `ms`; the timer never outlives the promise. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      () => (clearTimeout(timer), resolve(undefined)),
    );
  });
}

type Target = {
  addEventListener?: (t: string, f: () => void) => void;
  removeEventListener?: (t: string, f: () => void) => void;
} | null | undefined;

export function createDuplexSession(hooks: DuplexTestHooks = {}): DuplexSession {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let micSource: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let sink: GainNode | null = null;
  let tap: GainNode | null = null;
  let workletLoaded = false;
  let stamp: 'worklet' | 'script-processor' | null = null;
  let scriptFrame: number | null = null;
  let chunks: Chunk[] = [];
  let chunksTotal = 0;
  let route: RouteInfo | null = null;
  let activeDeviceId = '';
  let micReady = false;
  let micWanted = false;
  let micPromise: Promise<RouteInfo> | null = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let wasRunning = false;
  let listeners: ((r: InterruptReason) => void)[] = [];
  let playing: { stop(): void } | null = null;
  let take: { stop(): void; settled: Promise<unknown> } | null = null;
  let takeActive = false;
  /** Undo list for what the session installed on the page (document, context, audio session listeners). */
  const sessionCleanups: (() => void)[] = [];
  /** Undo list for what the microphone installed (track listeners, devicechange). */
  let micCleanups: (() => void)[] = [];

  const notify = (r: InterruptReason): void => {
    for (const l of [...listeners]) {
      try {
        l(r);
      } catch {
        // A listener that throws must not stop the others (or the take from ending).
      }
    }
  };

  const on = (target: Target, type: string, fn: () => void, into: (() => void)[]): void => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    into.push(() => target.removeEventListener?.(type, fn));
  };

  function applySessionType(): void {
    // Always set explicitly per mode: a leftover 'playback' would stop capture, a leftover 'play-and-record' keeps other apps ducked.
    setAudioSessionType(micWanted || micReady ? 'play-and-record' : 'playback');
  }

  function ensureContext(): AudioContext {
    if (ctx) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) throw new RecorderError('unsupported', 'This browser has no Web Audio, so the guide cannot play.');
    const c = new Ctor({ latencyHint: 'interactive' });
    ctx = c;
    wasRunning = c.state === 'running';
    const onState = (): void => {
      const st = String(c.state); // Safari adds 'interrupted' (phone call, Siri, alarm) to running / suspended / closed
      if (st === 'running') wasRunning = true;
      else if (st !== 'closed' && wasRunning) {
        wasRunning = false;
        notify('audio-session');
      }
    };
    on(c as unknown as Target, 'statechange', onState, sessionCleanups);
    if (typeof document !== 'undefined') {
      on(document as unknown as Target, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') notify('hidden');
        else void c.resume().catch(() => undefined);
      }, sessionCleanups);
      on(globalThis as unknown as Target, 'pagehide', () => notify('hidden'), sessionCleanups);
    }
    // Headphones plugged or unplugged (this also ends a guide that was playing into them), with or without a microphone open.
    on(globalThis.navigator?.mediaDevices as unknown as Target, 'devicechange', () => notify('device-change'), sessionCleanups);
    const audioSession = (globalThis.navigator as unknown as { audioSession?: Target & { state?: string } } | undefined)?.audioSession;
    if (audioSession) on(audioSession, 'statechange', () => {
      if (audioSession.state === 'interrupted') notify('audio-session');
    }, sessionCleanups);
    return c;
  }

  /** Starts (or restarts) the context. Called synchronously from prepare(): iOS only starts audio inside the tap. */
  function resumeContext(c: AudioContext): Promise<void> {
    if (c.state === 'running' || c.state === 'closed') return Promise.resolve();
    return raceTimeout(c.resume(), RESUME_WAIT_MS).then(() => undefined);
  }

  function trimIdle(): void {
    if (takeActive || !ctx || chunks.length < 2) return;
    const newest = chunks[chunks.length - 1];
    const keepFrom = newest.frame - IDLE_KEEP_SEC * ctx.sampleRate;
    let drop = 0;
    while (drop < chunks.length - 1 && chunks[drop].frame + chunks[drop].data.length < keepFrom) drop++;
    if (drop > 0) chunks.splice(0, drop);
  }

  function pushChunk(frame: number, data: Float32Array): void {
    hooks.onChunk?.(frame, data.length);
    chunks.push({ frame, data });
    chunksTotal++;
    trimIdle();
  }

  async function openMicrophone(deviceId: string): Promise<MediaStream> {
    const base: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    const md = navigator.mediaDevices;
    if (deviceId) {
      try {
        return await md.getUserMedia({ audio: { ...base, deviceId: { exact: deviceId } } });
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw err;
        // The chosen microphone is not connected any more: use the default one.
      }
    }
    return md.getUserMedia({ audio: base });
  }

  async function attachCapture(c: AudioContext, src: MediaStreamAudioSourceNode): Promise<void> {
    sink = c.createGain();
    sink.gain.value = 0;
    sink.connect(c.destination);
    if (!hooks.noWorklet && c.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      let url: string | null = null;
      try {
        if (!workletLoaded) {
          url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
          await c.audioWorklet.addModule(url);
          workletLoaded = true;
        }
        const node = new AudioWorkletNode(c, 'mimic-stamp', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        node.port.onmessage = (e: MessageEvent<{ f: number; d: Float32Array } | string>) => {
          if (typeof e.data !== 'string') pushChunk(e.data.f, e.data.d);
        };
        if (!hooks.loopback) src.connect(node); // in the Chromium loopback test the (beeping) fake mic stays out of the recording
        node.connect(sink);
        worklet = node;
        stamp = 'worklet';
        return;
      } catch {
        // A strict CSP can block blob: modules; the ScriptProcessor path still records.
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    }
    const node = c.createScriptProcessor(SCRIPT_BUFFER, 1, 1);
    scriptFrame = null;
    node.onaudioprocess = (e) => {
      const data = Float32Array.from(e.inputBuffer.getChannelData(0));
      // No stamp in this path: count frames from the first callback. The start is only about right (the sync estimate absorbs it).
      scriptFrame ??= Math.max(0, Math.round(c.currentTime * c.sampleRate) - data.length);
      pushChunk(scriptFrame, data);
      scriptFrame += data.length;
    };
    if (!hooks.loopback) src.connect(node);
    node.connect(sink);
    scriptNode = node;
    stamp = 'script-processor';
  }

  function detachMic(): void {
    for (const undo of micCleanups.splice(0)) undo();
    micCleanups = [];
    try {
      micSource?.disconnect();
      worklet?.disconnect();
      scriptNode?.disconnect();
      analyser?.disconnect();
      sink?.disconnect();
      tap?.disconnect();
    } catch {
      // Already disconnected.
    }
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.close?.();
    }
    if (scriptNode) scriptNode.onaudioprocess = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    micSource = null;
    analyser = null;
    worklet = null;
    scriptNode = null;
    sink = null;
    tap = null;
    stamp = null;
    micReady = false;
    chunks = [];
    activeDeviceId = '';
  }

  async function currentRoute(): Promise<RouteInfo> {
    const c = ctx;
    const rate = c?.sampleRate ?? 0;
    const devices = (await listInputDevices()) ?? [];
    const settings = (track?.getSettings?.() ?? {}) as MediaTrackSettings;
    const inputRate = typeof settings.sampleRate === 'number' ? settings.sampleRate : null;
    const active = track?.label || settings.deviceId || activeDeviceId;
    const r = describeRoute(
      devices.map((d) => ({ kind: 'audioinput' as const, deviceId: d.id, label: d.label })),
      active,
      rate,
      inputRate,
    );
    // The track label is the best name for the microphone in use, even when the device list is still unnamed.
    if (track?.label && !r.inputLabel) {
      r.inputLabel = track.label;
      r.kind = classifyRoute(track.label);
      r.labelsHidden = false;
      r.headphonesLikely = r.headphonesLikely || r.kind === 'wired' || r.kind === 'bluetooth';
    }
    route = r;
    return r;
  }

  async function attachMic(deviceId: string, resumed: Promise<void>): Promise<RouteInfo> {
    const reason = microphoneUnavailableReason();
    if (reason) throw new RecorderError(/frame/.test(reason) ? 'denied' : 'unsupported', reason);
    const c = ctx;
    if (!c) throw new Error('prepare() first');
    let s: MediaStream;
    try {
      s = await openMicrophone(deviceId);
    } catch (err) {
      throw toRecorderError(err);
    }
    if (closed || ctx !== c) {
      s.getTracks().forEach((t) => t.stop()); // closed while the permission sheet was up
      throw new Error('This audio session was closed.');
    }
    stream = s;
    try {
      await resumed;
      if (String(c.state) !== 'running') await raceTimeout(c.resume(), RESUME_WAIT_MS);
      track = s.getAudioTracks?.()[0] ?? s.getTracks()[0] ?? null;
      activeDeviceId = ((track?.getSettings?.() ?? {}) as MediaTrackSettings).deviceId ?? deviceId;
      micSource = c.createMediaStreamSource(s);
      analyser = c.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      micSource.connect(analyser);
      tap = c.createGain();
      await attachCapture(c, micSource);
      if (hooks.loopback) tap.connect(worklet ?? (scriptNode as ScriptProcessorNode));
      if (closed || ctx !== c) throw new Error('This audio session was closed.');
      on(track as unknown as Target, 'ended', () => notify('mic-ended'), micCleanups);
      on(track as unknown as Target, 'mute', () => notify('mic-ended'), micCleanups);
      on(track as unknown as Target, 'unmute', () => void c.resume().catch(() => undefined), micCleanups);
      micReady = true;
      applySessionType();
      return await currentRoute();
    } catch (err) {
      detachMic();
      throw err instanceof RecorderError ? err : toRecorderError(err);
    }
  }

  function prepare(opts: { mic: boolean; deviceId?: string }): Promise<RouteInfo> {
    if (closed) return Promise.reject(new Error('This audio session was closed. Open the phrase again.'));
    let c: AudioContext;
    try {
      micWanted ||= opts.mic;
      applySessionType(); // before the context exists, and inside the tap
      c = ensureContext();
    } catch (err) {
      return Promise.reject(toRecorderError(err));
    }
    const resumed = resumeContext(c);
    if (!opts.mic) return resumed.then(currentRoute);
    const want = opts.deviceId ?? loadMicChoice() ?? '';
    // After a phone call or an unplugged device the track can be dead while we still think the microphone is open.
    if (micReady && track?.readyState === 'ended') detachMic();
    if (micReady && (want === '' || want === activeDeviceId)) return resumed.then(currentRoute);
    if (micPromise) return micPromise.then(() => prepare(opts));
    if (micReady) detachMic(); // another microphone was picked
    const p = attachMic(want, resumed);
    micPromise = p;
    const clear = (): void => {
      if (micPromise === p) micPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  function listen(buffer: AudioBuffer, opts: ListenOptions): { stop(): void; position(): number } {
    const c = ctx;
    if (!c || closed) throw new Error('prepare() first');
    if (takeActive) throw new Error('A take is running. Stop it first.');
    playing?.stop();
    const from = Math.max(0, Math.min(buffer.duration, opts.from ?? 0));
    const to = Math.max(from, Math.min(buffer.duration, opts.to ?? buffer.duration));
    const span = to - from;
    const src = c.createBufferSource();
    src.buffer = buffer;
    if (opts.loop && span > 0) {
      src.loop = true;
      src.loopStart = from;
      src.loopEnd = to;
    }
    src.connect(c.destination);
    if (c.state !== 'running') void c.resume().catch(() => undefined);
    const startAt = c.currentTime + 0.02;
    let ended = false;
    const handle = {
      stop(): void {
        if (ended) return;
        try {
          src.stop();
        } catch {
          // Never started or already ended.
        }
        finish();
      },
    };
    function finish(): void {
      if (ended) return;
      ended = true;
      src.onended = null;
      try {
        src.disconnect();
      } catch {
        // Already disconnected.
      }
      if (playing === handle) playing = null;
      opts.onEnded?.();
    }
    src.onended = finish;
    if (opts.loop && span > 0) src.start(startAt, from);
    else src.start(startAt, from, span);
    playing = handle;
    return {
      stop: handle.stop,
      position(): number {
        if (ended) return NaN;
        const elapsed = Math.max(0, audibleTime(c) - startAt);
        return opts.loop && span > 0 ? from + (elapsed % span) : from + Math.min(elapsed, span);
      },
    };
  }

  function runTake(buffer: AudioBuffer, opts: TakeOptions): { done: Promise<TakeResult>; stop(): void } {
    const c = ctx;
    if (!c || closed || !micReady) throw new Error('prepare({ mic: true }) first');
    if (takeActive) throw new Error('A take is already running.');
    playing?.stop();
    const sr = c.sampleRate;
    const beats = Math.max(0, Math.min(8, Math.round(opts.countInBeats)));
    const bpm = Math.max(40, Math.min(240, opts.bpm || 100));
    const beat = 60 / bpm;
    const startedAtCtx = c.currentTime;
    const t0 = startedAtCtx + PRE_ROLL_SEC; // 450 ms of room tone before the first click (noise floor for the click probe)
    const offsets = opts.clickOffsetsSec?.length
      ? opts.clickOffsetsSec.filter((o) => Number.isFinite(o)).map((o) => Math.max(0, o)).sort((a, b) => a - b).slice(0, 8)
      : Array.from({ length: beats }, (_, k) => k * beat);
    const clickTimes = offsets.map((o) => t0 + o);
    const refStart = t0 + (opts.clickOffsetsSec?.length ? (offsets[offsets.length - 1] ?? 0) + beat : beats * beat);
    const guideEnd = refStart + buffer.duration;
    const endAt = guideEnd + (opts.mode === 'turn-taking' ? (opts.turnSec ?? buffer.duration + 1.5) : Math.max(0, opts.tailSec));
    const captureFrom = Math.round(startedAtCtx * sr); // first frame we keep
    takeActive = true;
    chunks = chunks.filter((ch) => ch.frame + ch.data.length > captureFrom); // forget the idle audio from before this take
    if (c.state !== 'running') void c.resume().catch(() => undefined);

    const scheduled: AudioScheduledSourceNode[] = [];
    const graph: AudioNode[] = [];
    const clickPeak = Math.max(0.01, Math.min(1, opts.clickGain ?? 0.4));
    clickTimes.forEach((when, k) => {
      const osc = c.createOscillator();
      const env = c.createGain();
      osc.frequency.value = k === 0 ? 2400 : 1800;
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(clickPeak, when + 0.002);
      env.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
      osc.connect(env).connect(c.destination);
      if (tap) env.connect(tap);
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
      };
      osc.start(when);
      osc.stop(when + 0.05);
      scheduled.push(osc);
      graph.push(osc, env);
    });
    const src = c.createBufferSource();
    src.buffer = buffer;
    const g = c.createGain();
    g.gain.value = Math.max(0, Math.min(2, opts.gain));
    src.connect(g).connect(c.destination);
    if (tap) g.connect(tap);
    src.start(refStart);
    scheduled.push(src);
    graph.push(src, g);

    let stopped = false;
    let resolveDone!: (r: TakeResult) => void;
    const done = new Promise<TakeResult>((res) => (resolveDone = res));
    const startWall = wall();
    const chunksAtStart = chunksTotal;
    let lastT = c.currentTime;
    let lastMoveWall = startWall;

    const flushWorklet = (): Promise<void> => {
      const w = worklet;
      if (!w) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, FLUSH_WAIT_MS);
        const prev = w.port.onmessage;
        w.port.onmessage = (e) => {
          if (e.data === 'flushed') {
            clearTimeout(timeout);
            w.port.onmessage = prev;
            resolve();
          } else prev?.call(w.port, e);
        };
        try {
          w.port.postMessage('flush');
        } catch {
          clearTimeout(timeout);
          w.port.onmessage = prev;
          resolve();
        }
      });
    };

    const assemble = (endedBy: TakeResult['endedBy'], reason: InterruptReason | null): TakeResult => {
      const sorted = [...chunks].sort((a, b) => a.frame - b.frame);
      const first = sorted.find((ch) => ch.frame + ch.data.length > captureFrom);
      const empty: TakeResult = {
        samples: new Float32Array(0),
        sampleRate: sr,
        refStartInCaptureSec: null,
        clickTimesInCaptureSec: [],
        guideEndInCaptureSec: null,
        droppedFrames: 0,
        endedBy,
        interruptedBy: reason,
        clockExact: stamp === 'worklet',
      };
      if (!first) return empty;
      const startFrame = Math.max(captureFrom, first.frame);
      let cursor = startFrame;
      let dropped = 0;
      const parts: Float32Array[] = [];
      for (const ch of sorted) {
        const end = ch.frame + ch.data.length;
        if (end <= cursor) continue;
        if (ch.frame > cursor) {
          dropped += ch.frame - cursor; // the worklet missed frames: pad with silence so the clock stays right
          parts.push(new Float32Array(ch.frame - cursor));
          cursor = ch.frame;
        }
        parts.push(ch.data.subarray(cursor - ch.frame));
        cursor = end;
      }
      const total = parts.reduce((s, p) => s + p.length, 0);
      const samples = new Float32Array(total);
      let w = 0;
      for (const p of parts) (samples.set(p, w), (w += p.length));
      return {
        samples,
        sampleRate: sr,
        refStartInCaptureSec: opts.mode === 'sing-along' ? (Math.round(refStart * sr) - startFrame) / sr : null,
        clickTimesInCaptureSec: clickTimes.map((t) => (Math.round(t * sr) - startFrame) / sr),
        guideEndInCaptureSec: (Math.round(guideEnd * sr) - startFrame) / sr,
        droppedFrames: dropped,
        endedBy,
        interruptedBy: reason,
        clockExact: stamp === 'worklet',
      };
    };

    const finish = async (endedBy: TakeResult['endedBy'], reason: InterruptReason | null = null): Promise<void> => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      listeners = listeners.filter((l) => l !== off);
      // Whatever is still scheduled (clicks, the guide) must not play on after a cancel.
      for (const s of scheduled) {
        try {
          s.stop();
        } catch {
          // Already ended.
        }
      }
      await flushWorklet();
      let result: TakeResult;
      try {
        result = assemble(endedBy, reason);
      } catch {
        result = { ...assemble('interrupted', reason), samples: new Float32Array(0) };
      }
      for (const n of graph) {
        try {
          n.disconnect();
        } catch {
          // Already disconnected.
        }
      }
      takeActive = false;
      take = null;
      chunks = chunks.filter((ch) => ch.frame + ch.data.length > Math.round(c.currentTime * sr) - IDLE_KEEP_SEC * sr);
      resolveDone(result);
    };

    const tick = (): void => {
      if (c.state === 'closed') return void finish('interrupted', 'audio-session');
      const t = c.currentTime;
      const now = wall();
      if (t > lastT + 1e-6) {
        lastT = t;
        lastMoveWall = now;
      } else if (now - lastMoveWall > STALL_MS) return void finish('interrupted', 'audio-session');
      if (now - startWall > NO_AUDIO_MS && chunksTotal === chunksAtStart) return void finish('interrupted', 'no-audio');
      if (t >= endAt) void finish('finished');
    };
    const timer = setInterval(tick, 50);
    const off = (r: InterruptReason): void => void finish('interrupted', r);
    listeners.push(off);
    const handle = { stop: (): void => void finish('stopped'), settled: done };
    take = handle;
    return { done, stop: handle.stop };
  }

  async function doClose(): Promise<void> {
    closed = true;
    playing?.stop();
    const t = take;
    if (t) {
      t.stop();
      await t.settled.catch(() => undefined);
    }
    for (const undo of sessionCleanups.splice(0)) undo();
    detachMic();
    const c = ctx;
    ctx = null;
    listeners = [];
    if (c && c.state !== 'closed') await c.close().catch(() => undefined); // close, not suspend: a silent open context keeps iOS in play-and-record
    route = null;
    setAudioSessionType('auto');
  }

  return {
    get context(): AudioContext {
      if (!ctx) throw new Error('prepare() first');
      return ctx;
    },
    get analyser(): AnalyserNode | null {
      return analyser;
    },
    get route(): RouteInfo | null {
      return route;
    },
    get bufferedFrames(): number {
      return chunks.reduce((s, c) => s + c.data.length, 0);
    },
    prepare,
    listen,
    runTake,
    onInterrupted(cb: (r: InterruptReason) => void): () => void {
      listeners.push(cb);
      return () => (listeners = listeners.filter((l) => l !== cb));
    },
    async refreshRoute(): Promise<RouteInfo | null> {
      if (closed || !ctx) return null;
      return currentRoute();
    },
    async resume(): Promise<boolean> {
      const c = ctx;
      if (!c || closed) return false;
      await resumeContext(c);
      return String(c.state) === 'running';
    },
    close(): Promise<void> {
      closing ??= doClose();
      return closing;
    },
  };
}
