// Test doubles for Web Audio, getUserMedia and the page around them, so the audio code can be tested in Node.
//
// The fake context has a manual clock (`advance`) and renders a real, tiny audio graph: buffer sources, oscillators, gains
// with automation, a channel merger and a stereo panner mix into the destination, and the microphone hears that output
// (delayed by `latencySec`, scaled by `leak`) plus a synthetic voice and room noise. The capture worklet is the REAL worklet
// source: audio/duplex.ts hands it over as a Blob URL, the fake reads the text back and runs it with the globals an
// AudioWorkletGlobalScope has (AudioWorkletProcessor, registerProcessor, currentFrame). Nothing here uses a timer; tests drive
// the audio clock with `advance()` and the JS timers with vitest's fake timers (see `runFor`).
//
// Nothing in the app imports this file; it is for *.test.ts(x) only.

import { resolveObjectURL } from 'node:buffer';
import { makeRng } from './synth';

const QUANTUM = 128;

// ---------------------------------------------------------------------------------------------------------- params

type ParamEvent = { type: 'set' | 'lin' | 'exp'; time: number; value: number };

export class FakeParam {
  private events: ParamEvent[] = [];
  constructor(public value: number) {}
  setValueAtTime(value: number, time: number): this {
    this.insert({ type: 'set', time, value });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.insert({ type: 'lin', time, value });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.insert({ type: 'exp', time, value });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }
  private insert(e: ParamEvent): void {
    this.events.push(e);
    this.events.sort((a, b) => a.time - b.time);
  }
  get automated(): boolean {
    return this.events.length > 0;
  }
  at(t: number): number {
    let prevT = -Infinity;
    let prevV = this.value;
    for (const e of this.events) {
      if (e.time > t) {
        if (Number.isFinite(prevT)) {
          if (e.type === 'lin') return prevV + ((e.value - prevV) * (t - prevT)) / (e.time - prevT);
          if (e.type === 'exp' && prevV > 0 && e.value > 0) return prevV * (e.value / prevV) ** ((t - prevT) / (e.time - prevT));
        }
        return prevV;
      }
      prevT = e.time;
      prevV = e.value;
    }
    return prevV;
  }
}

// ----------------------------------------------------------------------------------------------------------- nodes

type Sig = Float32Array[];
interface Connection {
  to: FakeNode;
  out: number;
  inp: number;
}

export class FakeNode {
  connections: Connection[] = [];
  disconnected = 0;
  constructor(readonly context: FakeAudioContext) {}
  connect<T extends FakeNode>(to: T, out = 0, inp = 0): T {
    this.connections.push({ to, out, inp });
    return to;
  }
  disconnect(): void {
    this.connections = [];
    this.disconnected++;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

export class FakeChannelMerger extends FakeNode {}
export class FakeStereoPanner extends FakeNode {
  pan = new FakeParam(0);
}
export class FakeDestination extends FakeNode {
  maxChannelCount = 2;
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  last = new Float32Array(2048);
  getFloatTimeDomainData(out: Float32Array): void {
    out.set(this.last.subarray(this.last.length - out.length));
  }
}

abstract class FakeSource extends FakeNode {
  startTime = Infinity;
  stopTime = Infinity;
  started = false;
  ended = false;
  onended: (() => void) | null = null;
  stopCalls = 0;
  start(when = 0, ..._rest: number[]): void {
    if (this.started) throw new DOMException('start() was called twice', 'InvalidStateError');
    this.started = true;
    this.startTime = Math.max(when, this.context.currentTime);
    this.context.sources.add(this);
  }
  stop(when = 0): void {
    if (!this.started) throw new DOMException('stop() before start()', 'InvalidStateError');
    this.stopCalls++;
    this.stopTime = Math.min(this.stopTime, Math.max(when, this.context.currentTime));
  }
  /** One block of the source's own signal, plus whether it has finished by the end of the block. */
  abstract render(frame0: number, n: number): { sig: Sig | null; finished: boolean };
}

export class FakeOscillator extends FakeSource {
  frequency = new FakeParam(440);
  type = 'sine';
  render(frame0: number, n: number): { sig: Sig | null; finished: boolean } {
    const sr = this.context.sampleRate;
    const out = new Float32Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const t = (frame0 + i) / sr;
      if (t < this.startTime || t >= this.stopTime) continue;
      out[i] = Math.sin(2 * Math.PI * this.frequency.at(t) * (t - this.startTime));
      any = true;
    }
    return { sig: any ? [out] : null, finished: (frame0 + n) / sr >= this.stopTime };
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new FakeParam(1);
  offset = 0;
  duration: number | undefined;
  override start(when = 0, offset = 0, duration?: number): void {
    super.start(when);
    this.offset = offset;
    this.duration = duration;
  }
  render(frame0: number, n: number): { sig: Sig | null; finished: boolean } {
    const buf = this.buffer;
    if (!buf) return { sig: null, finished: true };
    const sr = this.context.sampleRate;
    const chans = Array.from({ length: buf.numberOfChannels }, () => new Float32Array(n));
    const end = this.duration === undefined ? buf.duration : Math.min(buf.duration, this.offset + this.duration);
    let finished = false;
    let any = false;
    for (let i = 0; i < n; i++) {
      const t = (frame0 + i) / sr;
      if (t < this.startTime) continue;
      if (t >= this.stopTime) {
        finished = true;
        break;
      }
      let pos = this.offset + (t - this.startTime);
      if (this.loop) {
        const ls = this.loopStart;
        const le = this.loopEnd > ls ? Math.min(this.loopEnd, buf.duration) : buf.duration;
        if (pos >= le) pos = ls + ((pos - ls) % (le - ls));
      } else if (pos >= end) {
        finished = true;
        break;
      }
      const idx = Math.min(buf.length - 1, Math.floor(pos * buf.sampleRate));
      for (let c = 0; c < chans.length; c++) chans[c][i] = buf.getChannelData(c)[idx];
      any = true;
    }
    return { sig: any ? chans : null, finished };
  }
}

export class FakeAudioBuffer {
  readonly length: number;
  private data: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    length: number,
    readonly sampleRate: number,
  ) {
    this.length = length;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c];
  }
  copyToChannel(src: Float32Array, c: number, startInChannel = 0): void {
    this.data[c].set(src.subarray(0, this.length - startInChannel), startInChannel);
  }
}

class FakePort {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  peer: FakePort | null = null;
  closed = false;
  postMessage(data: unknown, _transfer?: unknown[]): void {
    // A real port delivers on a later turn of the event loop.
    queueMicrotask(() => {
      if (!this.closed) this.peer?.onmessage?.({ data });
    });
  }
  close(): void {
    this.closed = true;
  }
}

interface FakeProcessor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export class FakeWorkletNode extends FakeNode {
  readonly port = new FakePort();
  private readonly processor: FakeProcessor;
  /** The input this block (set by the source that feeds it). */
  inputBlock: Float32Array | null = null;
  constructor(ctx: FakeAudioContext, name: string, _options?: unknown) {
    super(ctx);
    const Cls = ctx.processors.get(name);
    if (!Cls) throw new DOMException(`The node name '${name}' is not defined in AudioWorkletGlobalScope.`, 'InvalidStateError');
    this.processor = new (Cls as new () => FakeProcessor)();
    ctx.nodes.push(this);
    // Wire the two ends of the message channel: this.port is the main-thread end.
    this.port.peer = this.processor.port;
    this.processor.port.peer = this.port;
  }
  runQuantum(frame0: number): void {
    FakeEnvState.processingFrame = frame0;
    FakeEnvState.processingRate = this.context.sampleRate;
    this.processor.process([this.inputBlock ? [this.inputBlock] : []], [[new Float32Array(QUANTUM)]]);
    this.inputBlock = null;
  }
}

export class FakeScriptProcessor extends FakeNode {
  onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array }; playbackTime: number }) => void) | null = null;
  private pending: Float32Array[] = [];
  private filled = 0;
  constructor(
    ctx: FakeAudioContext,
    readonly bufferSize: number,
  ) {
    super(ctx);
  }
  feed(block: Float32Array, frame0: number): void {
    this.pending.push(block);
    this.filled += block.length;
    if (this.filled < this.bufferSize) return;
    const all = new Float32Array(this.filled);
    let o = 0;
    for (const p of this.pending) (all.set(p, o), (o += p.length));
    this.pending = [];
    this.filled = 0;
    const sr = this.context.sampleRate;
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => all }, playbackTime: (frame0 + QUANTUM) / sr });
  }
}

export class FakeMediaStreamSource extends FakeNode {
  constructor(
    ctx: FakeAudioContext,
    readonly stream: FakeMediaStream,
  ) {
    super(ctx);
  }
}

// ----------------------------------------------------------------------------------------------------- stream and tracks

type Listener = () => void;

export class FakeTrack {
  readonly kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  stopCalls = 0;
  onended: Listener | null = null;
  onmute: Listener | null = null;
  onunmute: Listener | null = null;
  private listeners = new Map<string, Set<Listener>>();
  constructor(
    readonly label: string,
    readonly deviceId: string,
    private readonly settingsRate: number | null,
  ) {}
  getSettings(): Record<string, unknown> {
    return { deviceId: this.deviceId, ...(this.settingsRate ? { sampleRate: this.settingsRate } : {}) };
  }
  stop(): void {
    this.stopCalls++;
    this.readyState = 'ended';
  }
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((s, l) => s + l.size, 0);
  }
  fire(type: 'ended' | 'mute' | 'unmute'): void {
    if (type === 'ended') this.readyState = 'ended';
    if (type === 'mute') this.muted = true;
    if (type === 'unmute') this.muted = false;
    const prop = type === 'ended' ? this.onended : type === 'mute' ? this.onmute : this.onunmute;
    prop?.();
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

export class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  get live(): boolean {
    return this.tracks.some((t) => t.readyState === 'live' && !t.muted);
  }
}

// ----------------------------------------------------------------------------------------------------------- context

export class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' | 'interrupted';
  readonly sampleRate: number;
  frame = 0;
  readonly destination = new FakeDestination(this);
  readonly sources = new Set<FakeSource>();
  readonly processors = new Map<string, unknown>();
  readonly nodes: FakeNode[] = [];
  onstatechange: Listener | null = null;
  baseLatency = 0.01;
  outputLatency = 0.02;
  closeCalls = 0;
  resumeCalls = 0;
  readonly audioWorklet: { addModule(url: string): Promise<void> } | undefined;
  private outBlocks: Float32Array[] = [];
  private micSources: FakeMediaStreamSource[] = [];
  private listeners = new Map<string, Set<Listener>>();
  /** Left and right of everything sent to the destination, for assertions. */
  readonly rendered: { l: Float32Array[]; r: Float32Array[] } = { l: [], r: [] };

  constructor(
    readonly env: FakeAudio,
    options?: { sampleRate?: number; latencyHint?: unknown },
  ) {
    this.sampleRate = options?.sampleRate ?? env.options.sampleRate;
    this.state = env.options.startSuspended ? 'suspended' : 'running';
    this.audioWorklet = env.options.worklet ? { addModule: (url) => this.addModule(url) } : undefined;
    env.contexts.push(this);
  }

  get currentTime(): number {
    return this.frame / this.sampleRate;
  }

  private track<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  async addModule(url: string): Promise<void> {
    if (this.env.options.workletFails) throw new DOMException('The module could not be loaded (blocked).', 'AbortError');
    const blob = resolveObjectURL(url);
    if (!blob) throw new DOMException(`Unknown module URL ${url}`, 'AbortError');
    const text = await blob.text();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { p: g.AudioWorkletProcessor, r: g.registerProcessor };
    g.AudioWorkletProcessor = class {
      port = new FakePort();
    };
    g.registerProcessor = (name: string, cls: unknown) => {
      this.processors.set(name, cls);
    };
    try {
      (0, eval)(text);
    } finally {
      g.AudioWorkletProcessor = saved.p;
      g.registerProcessor = saved.r;
    }
  }

  createGain(): FakeGain {
    return this.track(new FakeGain(this));
  }
  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator(this));
  }
  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource(this));
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    if (!(length > 0) || !(channels >= 1) || !(sampleRate >= 3000)) throw new DOMException('Bad buffer size', 'NotSupportedError');
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createChannelMerger(): FakeChannelMerger {
    return this.track(new FakeChannelMerger(this));
  }
  createStereoPanner(): FakeStereoPanner {
    return this.track(new FakeStereoPanner(this));
  }
  createAnalyser(): FakeAnalyser {
    return this.track(new FakeAnalyser(this));
  }
  createMediaStreamSource(stream: FakeMediaStream): FakeMediaStreamSource {
    const s = this.track(new FakeMediaStreamSource(this, stream));
    this.micSources.push(s);
    return s;
  }
  /** Accepts the formats in env.options.decodes (recognised by magic bytes) and answers with a short silent buffer. */
  async decodeAudioData(data: ArrayBuffer, ok?: (b: FakeAudioBuffer) => void, fail?: (e: unknown) => void): Promise<FakeAudioBuffer> {
    const b = new Uint8Array(data);
    const tag = (o: number): string => String.fromCharCode(...b.subarray(o, o + 4));
    const kind = tag(0) === 'RIFF' ? 'wav' : tag(0) === 'FORM' ? 'aiff' : tag(0) === 'caff' ? 'caf' : b[0] === 0xff && (b[1] & 0xe0) === 0xe0 ? 'mp3' : null;
    await Promise.resolve();
    const allowed = this.env.options.decodes ?? ['wav', 'aiff', 'caf', 'mp3'];
    if (data.byteLength === 0 || !kind || !allowed.includes(kind)) {
      const err = new DOMException('Unable to decode audio data', 'EncodingError');
      fail?.(err);
      throw err;
    }
    const buf = this.createBuffer(1, Math.round(0.25 * this.sampleRate), this.sampleRate);
    ok?.(buf);
    return buf;
  }

  createScriptProcessor(bufferSize: number): FakeScriptProcessor {
    return this.track(new FakeScriptProcessor(this, bufferSize));
  }

  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    return { contextTime: Math.max(0, this.currentTime - this.outputLatency), performanceTime: 0 };
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((s, l) => s + l.size, 0) + (this.onstatechange ? 1 : 0);
  }

  setState(state: FakeAudioContext['state']): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
    for (const fn of [...(this.listeners.get('statechange') ?? [])]) fn();
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.state === 'closed') throw new DOMException('The context is closed', 'InvalidStateError');
    if (this.env.options.resumeNeverSettles) return new Promise<void>(() => undefined);
    await Promise.resolve();
    if ((this.state as string) !== 'closed') this.setState('running');
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (this.state === 'closed') throw new DOMException('The context is already closed', 'InvalidStateError');
    await Promise.resolve();
    this.state = 'closed';
    for (const s of this.sources) s.ended = true;
    this.onstatechange?.();
    for (const fn of [...(this.listeners.get('statechange') ?? [])]) fn();
  }

  /** What the destination got for frames [from, from + n); zeros before anything played. */
  readOutput(from: number, n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = from + i;
      if (f < 0) continue;
      const b = this.outBlocks[Math.floor(f / QUANTUM)];
      if (b) out[i] = b[f % QUANTUM];
    }
    return out;
  }

  /** The whole rendered output as a flat array: left or right. */
  renderedChannel(which: 'l' | 'r'): Float32Array {
    const blocks = this.rendered[which];
    const out = new Float32Array(blocks.length * QUANTUM);
    blocks.forEach((b, i) => out.set(b, i * QUANTUM));
    return out;
  }

  private deliver(c: Connection, sig: Sig, frame0: number, acc: { l: Float32Array; r: Float32Array }): void {
    const to = c.to;
    const pick = (): Float32Array | undefined => sig[Math.min(c.out, sig.length - 1)];
    if (to instanceof FakeDestination) {
      if (sig.length >= 2) {
        acc.l.set(acc.l.map((v, i) => v + sig[0][i]));
        acc.r.set(acc.r.map((v, i) => v + sig[1][i]));
      } else {
        const m = sig[0];
        acc.l.set(acc.l.map((v, i) => v + m[i]));
        acc.r.set(acc.r.map((v, i) => v + m[i]));
      }
    } else if (to instanceof FakeGain) {
      const sr = this.sampleRate;
      const out = sig.map((ch) => {
        const o = new Float32Array(ch.length);
        for (let i = 0; i < ch.length; i++) o[i] = ch[i] * (to.gain.automated ? to.gain.at((frame0 + i) / sr) : to.gain.value);
        return o;
      });
      this.propagate(to, out, frame0, acc);
    } else if (to instanceof FakeChannelMerger) {
      const src = pick();
      if (!src) return;
      const z = new Float32Array(src.length);
      this.propagate(to, c.inp === 0 ? [src, z] : [z, src], frame0, acc);
    } else if (to instanceof FakeStereoPanner) {
      const src = pick();
      if (!src) return;
      const p = Math.max(-1, Math.min(1, to.pan.value));
      const gl = p <= 0 ? 1 : 1 - p;
      const gr = p >= 0 ? 1 : 1 + p;
      this.propagate(to, [src.map((v) => v * gl), src.map((v) => v * gr)], frame0, acc);
    }
  }

  private propagate(from: FakeNode, sig: Sig, frame0: number, acc: { l: Float32Array; r: Float32Array }): void {
    for (const c of from.connections) this.deliver(c, sig, frame0, acc);
  }

  /** Renders one 128-frame block: output graph, then the microphone, then the nodes that listen to it. */
  private quantum(): void {
    const frame0 = this.frame;
    const acc = { l: new Float32Array(QUANTUM), r: new Float32Array(QUANTUM) };
    for (const s of [...this.sources]) {
      if (s.ended) continue;
      const { sig, finished } = s.render(frame0, QUANTUM);
      if (sig) this.propagate(s, sig, frame0, acc);
      if (finished) {
        s.ended = true;
        this.sources.delete(s);
        queueMicrotask(() => s.onended?.());
      }
    }
    this.rendered.l.push(acc.l);
    this.rendered.r.push(acc.r);
    const mono = new Float32Array(QUANTUM);
    for (let i = 0; i < QUANTUM; i++) mono[i] = 0.5 * (acc.l[i] + acc.r[i]);
    this.outBlocks.push(mono);

    const mic = this.env.micBlock(this, frame0, QUANTUM);
    for (const ms of this.micSources) {
      if (!ms.stream.live) continue;
      for (const c of ms.connections) {
        if (c.to instanceof FakeWorkletNode) c.to.inputBlock = mic;
        else if (c.to instanceof FakeAnalyser) {
          const merged = new Float32Array(c.to.last.length);
          merged.set(c.to.last.subarray(QUANTUM));
          merged.set(mic, merged.length - QUANTUM);
          c.to.last = merged;
        } else if (c.to instanceof FakeScriptProcessor) c.to.feed(mic, frame0);
      }
    }
    if (!FakeEnvState.stalled) for (const n of this.nodes) if (n instanceof FakeWorkletNode) n.runQuantum(frame0);
    this.frame += QUANTUM;
  }

  /** The clock jumps ahead without rendering (an audio-thread glitch): whatever was due in between is lost. */
  skip(sec: number): void {
    if (this.state === 'running') this.frame += Math.round((sec * this.sampleRate) / QUANTUM) * QUANTUM;
  }

  /** Advances the audio clock by `sec` (whole 128-frame blocks); does nothing unless the context is running. */
  advance(sec: number): void {
    const blocks = Math.max(0, Math.round((sec * this.sampleRate) / QUANTUM));
    for (let i = 0; i < blocks; i++) {
      if (this.state !== 'running') return;
      this.quantum();
    }
  }
}

// -------------------------------------------------------------------------------------------------------- the world

export interface FakeDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
  groupId?: string;
}

export interface FakeAudioOptions {
  sampleRate?: number;
  devices?: FakeDevice[];
  /** Acoustic plus hardware delay from the destination to the microphone, seconds. */
  latencySec?: number;
  /** Gain of the playback in the microphone: 0 = sealed headphones, 1 = a loud speaker. */
  leak?: number;
  /** Room noise RMS in the microphone. */
  noiseRms?: number;
  /** Singing voice in the microphone: samples for frames [frame, frame + n). */
  voice?: (frame: number, n: number, sampleRate: number) => Float32Array | null;
  /** Replaces the whole microphone signal. */
  mic?: (frame: number, n: number, sampleRate: number) => Float32Array;
  /** AudioWorklet available (default true). */
  worklet?: boolean;
  /** addModule rejects (a CSP that blocks blob: modules). */
  workletFails?: boolean;
  /** navigator.audioSession exists (default true). */
  audioSession?: boolean;
  /** getUserMedia rejects with this error name. */
  micError?: string;
  /** Sample rate the microphone track reports. */
  inputSampleRate?: number | null;
  /** Contexts start 'suspended' and become 'running' on resume() (Safari). Default true. */
  startSuspended?: boolean;
  /** resume() never settles (iOS while a permission sheet is up). */
  resumeNeverSettles?: boolean;
  /** navigator.wakeLock exists. */
  wakeLock?: boolean;
  /** Container formats decodeAudioData accepts (by their magic bytes). Default wav, aiff, caf, mp3. */
  decodes?: ('wav' | 'aiff' | 'caf' | 'mp3')[];
  /** getUserMedia waits for this before answering (a permission sheet that is still up). */
  micGate?: Promise<void>;
}

const DEFAULT_DEVICES: FakeDevice[] = [{ deviceId: 'iphone-mic', label: 'iPhone Microphone', kind: 'audioinput', groupId: 'g1' }];

/** The slice of module state the fake worklet global scope reads. */
const FakeEnvState = { processingFrame: 0, processingRate: 48000, stalled: false };

export class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  permissionsPolicy = undefined;
}

export interface FakeAudio {
  readonly options: Required<Pick<FakeAudioOptions, 'sampleRate' | 'worklet' | 'startSuspended'>> & FakeAudioOptions;
  contexts: FakeAudioContext[];
  streams: FakeMediaStream[];
  getUserMediaCalls: MediaStreamConstraints[];
  /** Every value written to navigator.audioSession.type, in order. */
  sessionTypes: string[];
  /** Object URLs created minus revoked. */
  liveObjectUrls: Set<string>;
  document: FakeDocument;
  devices: FakeDevice[];
  /** Advance every context's audio clock. */
  advance(sec: number): void;
  /** The worklet stops being called (nothing arrives from the microphone) while the clock keeps running. */
  stallWorklet(on: boolean): void;
  /** The audio thread glitches: the clock jumps ahead by this many seconds without rendering them. */
  glitch(sec: number): void;
  micBlock(ctx: FakeAudioContext, frame0: number, n: number): Float32Array;
  setLeak(leak: number): void;
  setLatency(sec: number): void;
  setVoice(voice: FakeAudioOptions['voice']): void;
  /** The microphone track ends (device removed, another app took it). */
  endMic(): void;
  muteMic(): void;
  unmuteMic(): void;
  /** Replace the device list and fire `devicechange`. */
  changeDevices(devices: FakeDevice[]): void;
  hidePage(): void;
  showPage(): void;
  /** The audio session is interrupted (phone call, Siri, alarm). */
  interruptAudio(): void;
  fireAudioSessionState(state: 'active' | 'inactive' | 'interrupted'): void;
  /** Undo every global this installed. */
  restore(): void;
}

export function installFakeAudio(options: FakeAudioOptions = {}): FakeAudio {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown, getter?: () => unknown): void => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, getter ? { configurable: true, get: getter } : { configurable: true, writable: true, value });
  };

  const rng = makeRng(99);
  const devices: FakeDevice[] = options.devices ? [...options.devices] : [...DEFAULT_DEVICES];
  const sessionTypes: string[] = [];
  const liveObjectUrls = new Set<string>();
  const mediaListeners = new Map<string, Set<Listener>>();
  const sessionListeners = new Map<string, Set<Listener>>();
  const doc = new FakeDocument();
  let micTrack: FakeTrack | null = null;

  const env: FakeAudio = {
    options: { ...options, sampleRate: options.sampleRate ?? 48000, worklet: options.worklet ?? true, startSuspended: options.startSuspended ?? true },
    contexts: [],
    streams: [],
    getUserMediaCalls: [],
    sessionTypes,
    liveObjectUrls,
    document: doc,
    devices,
    advance(sec) {
      for (const c of env.contexts) c.advance(sec);
    },
    stallWorklet(on) {
      FakeEnvState.stalled = on;
    },
    glitch(sec) {
      for (const c of env.contexts) c.skip(sec);
    },
    micBlock(ctx, frame0, n) {
      const sr = ctx.sampleRate;
      if (options.mic) return options.mic(frame0, n, sr);
      const out = new Float32Array(n);
      const latencyFrames = Math.round((options.latencySec ?? 0) * sr);
      const leak = options.leak ?? 0;
      if (leak > 0) {
        const heard = ctx.readOutput(frame0 - latencyFrames, n);
        for (let i = 0; i < n; i++) out[i] += leak * heard[i];
      }
      const v = options.voice?.(frame0, n, sr);
      if (v) for (let i = 0; i < n; i++) out[i] += v[i];
      const noise = options.noiseRms ?? 0.0005;
      if (noise > 0) for (let i = 0; i < n; i++) out[i] += (rng() - 0.5) * 2 * noise * Math.sqrt(3);
      return out;
    },
    setLeak(leak) {
      options.leak = leak;
    },
    setLatency(sec) {
      options.latencySec = sec;
    },
    setVoice(voice) {
      options.voice = voice;
    },
    endMic() {
      micTrack?.fire('ended');
    },
    muteMic() {
      micTrack?.fire('mute');
    },
    unmuteMic() {
      micTrack?.fire('unmute');
    },
    changeDevices(next) {
      devices.splice(0, devices.length, ...next);
      for (const fn of [...(mediaListeners.get('devicechange') ?? [])]) fn();
    },
    hidePage() {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    showPage() {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    interruptAudio() {
      for (const c of env.contexts) if (c.state === 'running') c.setState('interrupted');
    },
    fireAudioSessionState(state) {
      session.state = state;
      for (const fn of [...(sessionListeners.get('statechange') ?? [])]) fn();
    },
    restore() {
      FakeEnvState.stalled = false;
      for (const [name, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, name, desc);
        else delete g[name];
      }
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };

  const session = {
    _type: 'auto',
    state: 'inactive' as string,
    get type(): string {
      return this._type;
    },
    set type(v: string) {
      this._type = v;
      sessionTypes.push(v);
    },
    addEventListener(type: string, fn: Listener) {
      if (!sessionListeners.has(type)) sessionListeners.set(type, new Set());
      sessionListeners.get(type)?.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      sessionListeners.get(type)?.delete(fn);
    },
  };

  const mediaDevices = {
    async getUserMedia(constraints: MediaStreamConstraints): Promise<FakeMediaStream> {
      env.getUserMediaCalls.push(constraints);
      await Promise.resolve();
      if (options.micGate) await options.micGate;
      if (options.micError) throw Object.assign(new Error(options.micError), { name: options.micError });
      const audio = constraints.audio as MediaTrackConstraints | boolean | undefined;
      const wanted = typeof audio === 'object' && audio.deviceId && typeof audio.deviceId === 'object' ? (audio.deviceId as { exact?: string }).exact : undefined;
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const dev = wanted ? inputs.find((d) => d.deviceId === wanted) : inputs[0];
      if (wanted && !dev) throw Object.assign(new Error('Requested device not found'), { name: 'OverconstrainedError' });
      if (!dev) throw Object.assign(new Error('No microphone'), { name: 'NotFoundError' });
      const rate = options.inputSampleRate === undefined ? env.options.sampleRate : options.inputSampleRate;
      micTrack = new FakeTrack(dev.label, dev.deviceId, rate);
      const stream = new FakeMediaStream([micTrack]);
      env.streams.push(stream);
      return stream;
    },
    async enumerateDevices(): Promise<FakeDevice[]> {
      await Promise.resolve();
      return devices.map((d) => ({ ...d }));
    },
    addEventListener(type: string, fn: Listener) {
      if (!mediaListeners.has(type)) mediaListeners.set(type, new Set());
      mediaListeners.get(type)?.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      mediaListeners.get(type)?.delete(fn);
    },
    listenerCount(): number {
      return [...mediaListeners.values()].reduce((s, l) => s + l.size, 0);
    },
  };
  (env as FakeAudio & { mediaDevices: typeof mediaDevices }).mediaDevices = mediaDevices;
  (env as FakeAudio & { session: typeof session }).session = session;

  const nav: Record<string, unknown> = {
    userAgent: 'FakeAudio/1.0',
    platform: 'FakePlatform',
    maxTouchPoints: 0,
    mediaDevices,
    ...(options.audioSession === false ? {} : { audioSession: session }),
    ...(options.wakeLock ? { wakeLock: { request: async () => ({ release: async () => undefined, addEventListener() {} }) } } : {}),
  };

  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = originalCreate.call(URL, obj as Blob);
    liveObjectUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url: string): void => {
    liveObjectUrls.delete(url);
    originalRevoke.call(URL, url);
  };

  class BoundContext extends FakeAudioContext {
    constructor(opts?: { sampleRate?: number; latencyHint?: unknown }) {
      super(env, opts);
    }
  }
  class BoundWorkletNode extends FakeWorkletNode {}
  define('AudioContext', BoundContext);
  define('AudioWorkletNode', options.worklet === false ? undefined : BoundWorkletNode);
  define('navigator', nav);
  define('document', doc);
  define('isSecureContext', true);
  define('currentFrame', undefined, () => FakeEnvState.processingFrame);
  define('sampleRate', undefined, () => FakeEnvState.processingRate);
  return env;
}

/**
 * Runs the audio clock and the JS timers together in 10 ms steps, so code that polls with setInterval sees a consistent world.
 * `tick` advances the timers: `(ms) => vi.advanceTimersByTimeAsync(ms)`.
 */
export async function runFor(env: FakeAudio, sec: number, tick: (ms: number) => Promise<unknown>): Promise<void> {
  const steps = Math.max(1, Math.round(sec / 0.01));
  for (let i = 0; i < steps; i++) {
    env.advance(0.01);
    await tick(10);
  }
}
