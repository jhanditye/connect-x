// Phrase playback: pre-rendered slow / transposed guide buffers and a small player on the shared AudioContext.
//
// AudioBufferSourceNode.playbackRate moves the pitch and Safari's preservesPitch path has had bugs, so a slowed or
// transposed guide is rendered ahead of time with WSOLA (dsp/timestretch.ts) in a worker (dsp/stretchClient.ts) and cached.
// Times in this file's player are PHRASE seconds, the reference's own time axis (the same one the practice strip and the
// loop handles use); the player converts to and from the slowed buffer's time with the rate the buffer was rendered at.

import { renderGuideOffMainThread, type RenderClientOptions } from '../dsp/stretchClient';
import { abortError, MAX_RATE, MAX_SHIFT_SEMITONES, MIN_RATE } from '../dsp/timestretch';
import type { PhraseAudio } from '../trainer/phraseAnalysis';
import type { PlayMode } from '../types';
import { audibleTime } from './duplex';

export interface PhrasePlayer {
  /** Length of the phrase in phrase seconds (the buffer's length times the rate it was rendered at). */
  readonly durationSec: number;
  /** Playhead in phrase seconds at the audible output (getOutputTimestamp); NaN when stopped. */
  position(): number;
  /** Stops anything playing, then plays. `from` / `to` are phrase seconds. `onEnded` fires once when this playback ends or is stopped or replaced. Never throws. */
  play(opts: { from?: number; to?: number; loop?: boolean; gain?: number; pan?: -1 | 0 | 1; onEnded?: () => void }): void;
  stop(): void;
  dispose(): void;
}

export interface PreparedPlayback {
  buffer: AudioBuffer;
  rate: number;
  semitones: number;
}

// ------------------------------------------------------------------------------------------------------------ cache

export interface PlaybackCacheLimits {
  maxEntries: number;
  maxBytes: number;
}

/** About eight rendered buffers or 30 MB, whichever comes first (a 12 s phrase at 48 kHz is 2.3 MB). */
export const DEFAULT_CACHE_LIMITS: PlaybackCacheLimits = { maxEntries: 8, maxBytes: 30 * 1024 * 1024 };

const bufferBytes = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4;

/** Least recently used rendered guides. Pure bookkeeping: it never touches audio. */
export class PlaybackCache {
  private readonly map = new Map<string, PreparedPlayback>();
  constructor(private limits: PlaybackCacheLimits = DEFAULT_CACHE_LIMITS) {}

  get(key: string): PreparedPlayback | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: PreparedPlayback): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.evict();
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    let n = 0;
    for (const v of this.map.values()) n += bufferBytes(v.buffer);
    return n;
  }

  private evict(): void {
    // Always keep the newest entry, even if it alone is over the byte limit.
    while (this.map.size > 1 && (this.map.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes)) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
}

const sharedCache = new PlaybackCache();

export function clearPlaybackCache(): void {
  sharedCache.clear();
}

export function playbackCacheStats(): { entries: number; bytes: number } {
  return { entries: sharedCache.size, bytes: sharedCache.bytes };
}

const audioIds = new WeakMap<object, number>();
let nextAudioId = 1;
/** A key for an audio array that stays the same for as long as the array lives. */
function idOf(samples: Float32Array): number {
  let id = audioIds.get(samples);
  if (id === undefined) {
    id = nextAudioId++;
    audioIds.set(samples, id);
  }
  return id;
}

interface Inflight {
  promise: Promise<PreparedPlayback>;
  controller: AbortController;
  refs: number;
}
const inflight = new Map<string, Inflight>();

// ---------------------------------------------------------------------------------------------------------- buffers

/** Mono samples into an AudioBuffer (a copy). Throws a plain Error with the next step when there is nothing to play. */
export function bufferFromSamples(ctx: Pick<BaseAudioContext, 'createBuffer'>, samples: Float32Array, sampleRate: number): AudioBuffer {
  if (!(samples.length > 0) || !(sampleRate > 0)) throw new Error('There is no audio to play. Add the clip file again or pick another phrase.');
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  if (typeof buf.copyToChannel === 'function') buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  else buf.getChannelData(0).set(samples);
  return buf;
}

/** Scales so the loudest sample is `target` (default 0.9). Silence stays silent; NaN becomes 0. Returns a new array. */
export function peakNormalize(x: Float32Array, target = 0.9): Float32Array {
  const out = new Float32Array(x.length);
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) continue;
    out[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak < 1e-9) return out;
  const g = target / peak;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

/**
 * The two takes side by side for headphones: the guide in the left ear, the attempt in the right, the attempt shifted so that
 * `attemptT0Sec` (the moment in the attempt that belongs to guide time 0) lines up with the start of the guide. A negative
 * `attemptT0Sec` (the singer came in before the guide) pads the right ear with silence. Both at the same sample rate.
 */
export function sideBySide(guide: Float32Array, attempt: Float32Array, sampleRate: number, attemptT0Sec: number): { left: Float32Array; right: Float32Array } {
  if (!(sampleRate > 0)) throw new RangeError('sampleRate must be positive');
  const shift = Number.isFinite(attemptT0Sec) ? Math.round(attemptT0Sec * sampleRate) : 0;
  const length = Math.max(guide.length, attempt.length - shift, 0);
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  left.set(guide.subarray(0, length));
  for (let i = 0; i < length; i++) {
    const j = i + shift;
    if (j >= 0 && j < attempt.length) right[i] = attempt[j];
  }
  return { left, right };
}

/** The attempt as a mono buffer for the [You] button: a copy, peak-normalised so a quiet room mic is still audible. */
export function attemptBuffer(ctx: Pick<BaseAudioContext, 'createBuffer'>, attempt: { samples: Float32Array; sampleRate: number }): AudioBuffer {
  return bufferFromSamples(ctx, peakNormalize(attempt.samples), attempt.sampleRate);
}

/**
 * Which moment of the attempt recording lines up with guide-buffer time 0, for hearBothBuffer.
 * - sing-along: the guide started at `refStartInCaptureSec` in the recording and the singer was `syncOffsetMs` late behind it,
 *   so the singing that answers guide time 0 sits at refStart + offset.
 * - turn-taking: there is no shared clock; line up the first sung note (`matchedStartSec`, where the scorer found it in the
 *   attempt) with the reference's first note (`refFirstNoteSec` in phrase seconds, which is refFirstNoteSec / rate in the buffer).
 */
export function attemptStartForBoth(p: {
  mode: PlayMode;
  refStartInCaptureSec: number | null;
  syncOffsetMs: number | null;
  matchedStartSec: number | null;
  refFirstNoteSec: number;
  rate: number;
}): number {
  if (p.mode === 'sing-along' && p.refStartInCaptureSec !== null && Number.isFinite(p.refStartInCaptureSec)) {
    return p.refStartInCaptureSec + (p.syncOffsetMs !== null && Number.isFinite(p.syncOffsetMs) ? p.syncOffsetMs / 1000 : 0);
  }
  if (p.matchedStartSec !== null && Number.isFinite(p.matchedStartSec)) return p.matchedStartSec - p.refFirstNoteSec / (p.rate > 0 ? p.rate : 1);
  return 0;
}

/** A stereo buffer for `sideBySide`, both channels peak-normalised to the same level so neither ear hides the other. */
export function hearBothBuffer(
  ctx: Pick<BaseAudioContext, 'createBuffer'>,
  guide: PreparedPlayback,
  attempt: { samples: Float32Array; sampleRate: number },
  attemptT0Sec: number,
): AudioBuffer {
  const sr = guide.buffer.sampleRate;
  if (attempt.sampleRate !== sr) throw new RangeError(`The attempt (${attempt.sampleRate} Hz) and the guide (${sr} Hz) must be at the same rate.`);
  const { left, right } = sideBySide(peakNormalize(guide.buffer.getChannelData(0), 0.8), peakNormalize(attempt.samples, 0.8), sr, attemptT0Sec);
  if (left.length === 0) throw new Error('There is no audio to play. Add the clip file again or pick another phrase.');
  const buf = ctx.createBuffer(2, left.length, sr);
  buf.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  return buf;
}

// ----------------------------------------------------------------------------------------------------- preparePlayback

export interface PrepareOptions {
  signal?: AbortSignal;
  /** 0..1 while the guide is being rendered (a cached or trivial one reports nothing). */
  onProgress?: (fraction: number) => void;
  /** Default: the shared cache. `false` renders every time. */
  cache?: PlaybackCache | false;
  /** Passed to the render client (tests inject a worker double; diagnostics can force the main thread). */
  render?: RenderClientOptions;
}

const roundTo = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

/**
 * Renders the phrase at `rate` (0.5..1, down to MIN_RATE) and moved by `semitones`, as an AudioBuffer at the context's sample
 * rate (so the browser does no sample-rate conversion of its own and the start stays sample-exact). Cached by
 * (audio, rate, semitones, context rate). The work runs in a worker; rejects with an AbortError when `opts.signal` aborts.
 */
export async function preparePlayback(ctx: AudioContext, audio: PhraseAudio, rate: number, semitones: number, opts: PrepareOptions = {}): Promise<PreparedPlayback> {
  if (opts.signal?.aborted) throw abortError();
  if (!audio || !(audio.samples.length > 0) || !(audio.sampleRate > 0)) throw new Error('There is no audio to play. Add the clip file again or pick another phrase.');
  if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) throw new RangeError(`rate must be between ${MIN_RATE} and ${MAX_RATE}`);
  if (!Number.isFinite(semitones) || Math.abs(semitones) > MAX_SHIFT_SEMITONES) throw new RangeError(`semitones must be within ${MAX_SHIFT_SEMITONES}`);
  const r = roundTo(rate, 3);
  const st = roundTo(semitones, 2);
  const outRate = ctx.sampleRate;
  const cache = opts.cache === false ? null : (opts.cache ?? sharedCache);
  const key = `${idOf(audio.samples)}|${r}|${st}|${outRate}`;
  const hit = cache?.get(key);
  if (hit) return hit;

  if (r === 1 && st === 0 && audio.sampleRate === outRate) {
    const prepared = { buffer: bufferFromSamples(ctx, audio.samples, audio.sampleRate), rate: 1, semitones: 0 };
    cache?.set(key, prepared);
    return prepared;
  }

  // One render per key at a time: two chips tapped quickly share the work, and it stops when nobody waits any more.
  let entry = cache ? inflight.get(key) : undefined;
  if (!entry) {
    const controller = new AbortController();
    const created: Inflight = {
      controller,
      refs: 0,
      promise: renderGuideOffMainThread(audio.samples, audio.sampleRate, { rate: r, semitones: st, outRate }, { ...opts.render, signal: controller.signal, onProgress: opts.onProgress ?? opts.render?.onProgress }).then((out) => {
        const prepared = { buffer: bufferFromSamples(ctx, out.samples, out.sampleRate), rate: r, semitones: st };
        cache?.set(key, prepared);
        return prepared;
      }),
    };
    entry = created;
    if (cache) {
      inflight.set(key, created);
      const clear = (): void => {
        if (inflight.get(key) === created) inflight.delete(key);
      };
      created.promise.then(clear, clear);
    }
  }
  const mine = entry;
  mine.refs++;
  const signal = opts.signal;
  if (!signal) return mine.promise;
  return new Promise<PreparedPlayback>((resolve, reject) => {
    const onAbort = (): void => {
      if (--mine.refs <= 0) mine.controller.abort();
      reject(abortError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    mine.promise.then(
      (v) => (signal.removeEventListener('abort', onAbort), resolve(v)),
      (e) => (signal.removeEventListener('abort', onAbort), reject(e)),
    );
  });
}

// ----------------------------------------------------------------------------------------------------- the player

const PLAY_LEAD_SEC = 0.02;

function isPrepared(x: AudioBuffer | PreparedPlayback): x is PreparedPlayback {
  return (x as PreparedPlayback).buffer !== undefined && (x as PreparedPlayback).rate !== undefined;
}

/**
 * A player for one rendered phrase. `source` is a PreparedPlayback (its rate is used) or a plain AudioBuffer (then `opts.rate`,
 * default 1, says what speed it was rendered at). Mono buffers can be panned to one ear; stereo ones (hearBothBuffer) play as they are.
 */
export function createPhrasePlayer(ctx: AudioContext, source: AudioBuffer | PreparedPlayback, opts: { rate?: number } = {}): PhrasePlayer {
  const buffer = isPrepared(source) ? source.buffer : source;
  const rate = isPrepared(source) ? source.rate : (opts.rate ?? 1);
  const durationSec = buffer.duration * rate;
  let disposed = false;
  let current: { src: AudioBufferSourceNode; nodes: AudioNode[]; startAt: number; from: number; span: number; loop: boolean; end: () => void } | null = null;
  let ended = true;

  function silence(): void {
    const c = current;
    current = null;
    if (!c) return;
    c.src.onended = null;
    try {
      c.src.stop();
    } catch {
      // Never started or already ended.
    }
    for (const n of c.nodes) {
      try {
        n.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }

  function stop(): void {
    const c = current;
    if (!c) return;
    silence();
    c.end();
  }

  return {
    durationSec,
    position(): number {
      const c = current;
      if (!c || ended) return NaN;
      const elapsed = Math.max(0, audibleTime(ctx) - c.startAt) * rate;
      return c.loop && c.span > 0 ? c.from + (elapsed % c.span) : c.from + Math.min(elapsed, c.span);
    },
    play(o): void {
      if (disposed) return;
      stop();
      let finished = false;
      const end = (): void => {
        if (finished) return;
        finished = true;
        ended = true;
        if (current && current.end === end) current = null;
        o.onEnded?.();
      };
      try {
        const from = Math.max(0, Math.min(durationSec, o.from ?? 0));
        const to = Math.max(from, Math.min(durationSec, o.to ?? durationSec));
        const span = to - from;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(2, o.gain ?? 1));
        const nodes: AudioNode[] = [src, gain];
        src.connect(gain);
        const pan = buffer.numberOfChannels === 1 ? (o.pan ?? 0) : 0;
        if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
          const p = ctx.createStereoPanner();
          p.pan.value = pan;
          gain.connect(p).connect(ctx.destination);
          nodes.push(p);
        } else if (pan !== 0 && typeof ctx.createChannelMerger === 'function') {
          const m = ctx.createChannelMerger(2);
          gain.connect(m, 0, pan < 0 ? 0 : 1);
          m.connect(ctx.destination);
          nodes.push(m);
        } else gain.connect(ctx.destination);
        const loop = !!o.loop && span > 0;
        const fromBuf = from / rate;
        const spanBuf = span / rate;
        if (loop) {
          src.loop = true;
          src.loopStart = fromBuf;
          src.loopEnd = fromBuf + spanBuf;
        }
        src.onended = end;
        if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
        const startAt = ctx.currentTime + PLAY_LEAD_SEC;
        if (loop) src.start(startAt, fromBuf);
        else src.start(startAt, fromBuf, spanBuf);
        ended = false;
        current = { src, nodes, startAt, from, span, loop, end };
      } catch {
        // A closed context or a browser that refuses: report it as "playback ended" so the screen does not wait for ever.
        silence();
        ended = true;
        queueMicrotask(() => end());
      }
    },
    stop,
    dispose(): void {
      if (disposed) return;
      stop();
      disposed = true;
    },
  };
}
