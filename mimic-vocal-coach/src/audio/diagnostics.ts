// Device diagnostics behind Settings -> Trainer -> Diagnostics: small checks that say what this device really does, and a plain
// text report the singer can copy and send. Nothing here records or keeps audio, and nothing leaves the device unless the
// person shares the report themselves.
//
// Every check is feature-detected and never rejects for a failing device: that is a result with status 'fail' and a sentence
// that names what to do. A check that needs the microphone or a sound (click-probe, mic-level) is INTERACTIVE and is started
// from its own button, because iOS only allows both inside a tap.

import { analyzeInWorker } from '../analysis/client';
import { makeDemoTake } from '../analysis/demo';
import { renderGuideOffMainThread } from '../dsp/stretchClient';
import { renderGuide } from '../dsp/timestretch';
import { isIos, isStandalone, readEnv } from '../pwa/platform';
import { formatBytes, readStorageStatus } from '../pwa/storage';
import { blockLevel, LEVEL_TEXT, levelState } from '../ui/components/live';
import { probeClicks } from '../trainer/latency';
import { encodeWav } from './wav';
import { createDuplexSession, MAX_DROPPED_SEC } from './duplex';
import { loadMicChoice } from './micChoice';
import { RecorderError } from './recorder';
import { classifyRoute, describeRoute, listInputDevices, routeNotes } from './route';

export type DiagnosticId =
  | 'audio-context'
  | 'audio-session'
  | 'decode'
  | 'indexeddb'
  | 'analysis-speed'
  | 'stretch-speed'
  | 'click-probe'
  | 'route'
  | 'storage'
  | 'display-mode'
  | 'mic-level';

export interface DiagnosticResult {
  id: DiagnosticId;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  /** One line for the list. */
  summary: string;
  /** Numbers and flags for the copied report. */
  details: Record<string, string | number | boolean | null>;
  /** Keys of `details` that name the person's own gear (microphone names): left out of the report unless asked for. */
  sensitive?: string[];
}

export const DIAGNOSTIC_IDS: readonly DiagnosticId[] = [
  'audio-context',
  'audio-session',
  'decode',
  'indexeddb',
  'analysis-speed',
  'stretch-speed',
  'click-probe',
  'route',
  'storage',
  'display-mode',
  'mic-level',
];

export const DIAGNOSTIC_LABELS: Record<DiagnosticId, string> = {
  'audio-context': 'Audio engine',
  'audio-session': 'Audio session (silent switch)',
  decode: 'File formats this device can read',
  indexeddb: 'Storage for clips',
  'analysis-speed': 'Analysis speed',
  'stretch-speed': 'Slow and key-shift speed',
  'click-probe': 'Click test (delay through your headphones)',
  route: 'Microphones and headphones',
  storage: 'Storage space and persistence',
  'display-mode': 'This page and this device',
  'mic-level': 'Microphone level (10 seconds)',
};

/**
 * The checks that need no microphone and make no sound: "Run quick checks" runs these one after the other. The audio engine
 * check is first because it must start inside the tap that began the run (iOS only starts audio there).
 */
export const QUICK_DIAGNOSTICS: readonly DiagnosticId[] = ['audio-context', 'display-mode', 'audio-session', 'route', 'decode', 'indexeddb', 'storage', 'analysis-speed', 'stretch-speed'];
/** The checks that need the microphone or a sound, so each has its own button. */
export const INTERACTIVE_DIAGNOSTICS: readonly DiagnosticId[] = ['mic-level', 'click-probe'];

export interface DiagnosticProgress {
  /** 0..1 */
  fraction: number;
  /** Input level 0..1 (the mic-level check). */
  level?: number;
  /** Plain words for the person while it runs. */
  message?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (p: DiagnosticProgress) => void;
  /** mic-level length in seconds (default 10). */
  seconds?: number;
}

type Details = DiagnosticResult['details'];

function result(id: DiagnosticId, status: DiagnosticResult['status'], summary: string, details: Details, sensitive?: string[]): DiagnosticResult {
  return { id, label: DIAGNOSTIC_LABELS[id], status, summary, details, ...(sensitive?.length ? { sensitive } : {}) };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round = (v: number, places = 1): number => Math.round(v * 10 ** places) / 10 ** places;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The promise's value, or `fallback` after `ms` (a call that hangs must not hang the page). A rejection still rejects. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Runs `work` while a 2 ms timer watches how long the main thread was busy: the longest gap between two ticks. */
async function measureStall<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; maxGapMs: number }> {
  let last = now();
  let max = 0;
  const id = setInterval(() => {
    const t = now();
    max = Math.max(max, t - last);
    last = t;
  }, 2);
  await sleep(20);
  max = 0;
  last = now();
  const t0 = now();
  try {
    const value = await work();
    const ms = now() - t0;
    await sleep(10);
    return { value, ms, maxGapMs: max };
  } finally {
    clearInterval(id);
  }
}

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;
function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

// ------------------------------------------------------------------------------------------------------- audio engine

async function checkAudioContext(): Promise<DiagnosticResult> {
  const id = 'audio-context';
  const Ctor = audioContextCtor();
  if (!Ctor) return result(id, 'fail', 'This browser has no Web Audio, so the guide cannot play. Try Safari or Chrome.', { webAudio: false });
  const ctx = new Ctor({ latencyHint: 'interactive' });
  try {
    const initial = String(ctx.state);
    if (ctx.state !== 'running') await withTimeout(ctx.resume().catch(() => undefined), 1500, undefined);
    const after = String(ctx.state);
    const out = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    const details: Details = {
      webAudio: true,
      stateAtStart: initial,
      stateAfterResume: after,
      sampleRateHz: ctx.sampleRate,
      baseLatencyMs: typeof ctx.baseLatency === 'number' ? round(ctx.baseLatency * 1000) : null,
      outputLatencyMs: typeof out === 'number' ? round(out * 1000) : null,
      audioWorklet: !!ctx.audioWorklet,
      audioWorkletNode: typeof AudioWorkletNode !== 'undefined',
      maxOutputChannels: ctx.destination.maxChannelCount,
    };
    if (after !== 'running') return result(id, 'warn', `The audio engine did not start (${after}). iOS only starts audio from a tap: tap Run again.`, details);
    if (!ctx.audioWorklet) return result(id, 'warn', `${round(ctx.sampleRate / 1000, 2)} kHz, but this browser has no AudioWorklet: recording works, the timing of a take is only approximate.`, details);
    if (ctx.sampleRate < 32000) return result(id, 'warn', `The engine runs at ${round(ctx.sampleRate / 1000, 2)} kHz: pitch is fine, tone scores are less reliable.`, details);
    return result(id, 'ok', `Running at ${round(ctx.sampleRate / 1000, 2)} kHz. The click test measures the real delay through your headphones; the browser's own numbers are only a hint.`, details);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------------------------------- audio session

interface AudioSessionLike {
  type: string;
  readonly state?: string;
}

async function checkAudioSession(): Promise<DiagnosticResult> {
  const id = 'audio-session';
  const s = (globalThis.navigator as (Navigator & { audioSession?: AudioSessionLike }) | undefined)?.audioSession;
  if (!s) {
    return result(id, ios() ? 'warn' : 'info', ios() ? 'Not available on this iOS version (it needs 16.4). If the guide is silent, check the side switch is not on silent.' : 'Not available in this browser. Only iPhone needs it.', { present: false });
  }
  const before = s.type;
  let canSet = false;
  try {
    s.type = 'playback';
    canSet = s.type === 'playback';
  } catch {
    canSet = false;
  } finally {
    try {
      s.type = before;
    } catch {
      // Leave it as it is.
    }
  }
  const details: Details = { present: true, type: before, state: s.state ?? null, canSetPlayback: canSet };
  return canSet
    ? result(id, 'ok', 'Supported: the guide can play with the side switch on silent.', details)
    : result(id, 'warn', 'Present but it refused to switch to "playback". If the guide is silent, check the side switch is not on silent.', details);
}

const ios = (): boolean => {
  try {
    return isIos();
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------------------------------------------------ decode

const TEST_RATE = 22050;
function testTone(sec: number): Float32Array {
  return Float32Array.from({ length: Math.round(sec * TEST_RATE) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / TEST_RATE));
}
const toInt16 = (x: Float32Array): Int16Array => Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));

export function makeTestWav(): ArrayBuffer {
  return encodeWav(testTone(0.25), TEST_RATE);
}

/** 80-bit IEEE extended float of a positive integer (what an AIFF header stores for the sample rate). */
function extended80(value: number): Uint8Array {
  const out = new Uint8Array(10);
  const exp = Math.floor(Math.log2(value));
  const mant = BigInt(Math.round(value * 2 ** (63 - exp)));
  const e = 16383 + exp;
  out[0] = (e >> 8) & 0x7f;
  out[1] = e & 0xff;
  for (let i = 0; i < 8; i++) out[2 + i] = Number((mant >> BigInt(56 - 8 * i)) & 0xffn);
  return out;
}

export function makeTestAiff(): ArrayBuffer {
  const pcm = toInt16(testTone(0.25));
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(12 + 8 + 18 + 8 + 8 + dataBytes);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const tag = (o: number, s: string): void => [...s].forEach((c, i) => (u8[o + i] = c.charCodeAt(0)));
  tag(0, 'FORM');
  v.setUint32(4, buf.byteLength - 8);
  tag(8, 'AIFF');
  tag(12, 'COMM');
  v.setUint32(16, 18);
  v.setInt16(20, 1);
  v.setUint32(22, pcm.length);
  v.setInt16(26, 16);
  u8.set(extended80(TEST_RATE), 28);
  tag(38, 'SSND');
  v.setUint32(42, 8 + dataBytes);
  v.setUint32(46, 0);
  v.setUint32(50, 0);
  pcm.forEach((s, i) => v.setInt16(54 + 2 * i, s));
  return buf;
}

export function makeTestCaf(): ArrayBuffer {
  const pcm = toInt16(testTone(0.25));
  const dataBytes = 4 + pcm.length * 2;
  const buf = new ArrayBuffer(8 + 12 + 32 + 12 + dataBytes);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const tag = (o: number, s: string): void => [...s].forEach((c, i) => (u8[o + i] = c.charCodeAt(0)));
  tag(0, 'caff');
  v.setUint16(4, 1);
  v.setUint16(6, 0);
  tag(8, 'desc');
  v.setBigInt64(12, 32n);
  v.setFloat64(20, TEST_RATE);
  tag(28, 'lpcm');
  v.setUint32(32, 0); // big-endian signed integer samples
  v.setUint32(36, 2); // bytes per packet
  v.setUint32(40, 1); // frames per packet
  v.setUint32(44, 1); // channels
  v.setUint32(48, 16); // bits per channel
  tag(52, 'data');
  v.setBigInt64(56, BigInt(dataBytes));
  v.setUint32(64, 0); // edit count
  pcm.forEach((s, i) => v.setInt16(68 + 2 * i, s));
  return buf;
}

/** Ten MPEG-1 Layer III mono frames of silence at 44.1 kHz / 128 kbps: a valid header and an all-zero frame body. */
export function makeTestMp3(): ArrayBuffer {
  const frame = 417;
  const out = new Uint8Array(frame * 10);
  for (let i = 0; i < 10; i++) out.set([0xff, 0xfb, 0x90, 0xc0], i * frame);
  return out.buffer;
}

interface DecodeTest {
  key: string;
  label: string;
  make: () => ArrayBuffer;
}
const DECODE_TESTS: DecodeTest[] = [
  { key: 'wav', label: 'WAV', make: makeTestWav },
  { key: 'aiff', label: 'AIFF', make: makeTestAiff },
  { key: 'caf', label: 'CAF', make: makeTestCaf },
  { key: 'mp3', label: 'MP3', make: makeTestMp3 },
];

/** What the browser says it can play, without decoding anything (no sample files for these here). */
const PLAY_TYPES: { key: string; label: string; type: string }[] = [
  { key: 'm4a-aac', label: 'AAC in M4A', type: 'audio/mp4; codecs="mp4a.40.2"' },
  { key: 'alac', label: 'Apple Lossless', type: 'audio/mp4; codecs="alac"' },
  { key: 'flac', label: 'FLAC', type: 'audio/flac' },
  { key: 'ogg-vorbis', label: 'Ogg Vorbis', type: 'audio/ogg; codecs="vorbis"' },
  { key: 'opus', label: 'Opus', type: 'audio/ogg; codecs="opus"' },
  { key: 'caf', label: 'CAF', type: 'audio/x-caf' },
  { key: 'aiff', label: 'AIFF', type: 'audio/aiff' },
];

function decodeBytes(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  // Older Safari only has the callback form; newer ones also return a promise. Settle once either way.
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(bytes.slice(0), resolve, (e) => reject(e ?? new Error('decode failed')));
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function checkDecode(): Promise<DiagnosticResult> {
  const id = 'decode';
  const Ctor = audioContextCtor();
  if (!Ctor) return result(id, 'fail', 'This browser has no Web Audio, so it cannot read audio files.', {});
  const ctx = new Ctor();
  const details: Details = {};
  const decoded: string[] = [];
  const failed: string[] = [];
  try {
    for (const t of DECODE_TESTS) {
      try {
        const buf = await withTimeout(decodeBytes(ctx, t.make()), 4000, null);
        if (buf && buf.length > 0) {
          decoded.push(t.label);
          details[`decode.${t.key}`] = `ok, ${round(buf.duration, 2)} s at ${buf.sampleRate} Hz`;
        } else {
          failed.push(t.label);
          details[`decode.${t.key}`] = buf ? 'decoded to nothing' : 'no answer in 4 s';
        }
      } catch (e) {
        failed.push(t.label);
        details[`decode.${t.key}`] = `failed (${(e as { name?: string } | null)?.name ?? 'error'})`;
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  const canPlay: string[] = [];
  let probe: HTMLAudioElement | null = null;
  try {
    probe = typeof document !== 'undefined' ? document.createElement('audio') : null;
  } catch {
    probe = null;
  }
  for (const t of PLAY_TYPES) {
    const answer = probe && typeof probe.canPlayType === 'function' ? probe.canPlayType(t.type) : '';
    details[`play.${t.key}`] = answer === '' ? 'no' : answer;
    if (answer) canPlay.push(t.label);
  }
  const rec = (globalThis as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder;
  details['recorder.supported'] = !!rec;
  for (const type of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus']) {
    try {
      details[`recorder.${type}`] = rec ? rec.isTypeSupported(type) : false;
    } catch {
      details[`recorder.${type}`] = false;
    }
  }
  const tail = canPlay.length ? ` It says it can also play: ${canPlay.join(', ')} (not tested with a file).` : '';
  if (decoded.includes('WAV') && failed.length === 0) return result(id, 'ok', `Read ${decoded.length} of ${DECODE_TESTS.length} test files (${decoded.join(', ')}).${tail}`, details);
  if (decoded.includes('WAV')) return result(id, 'warn', `Read ${decoded.join(', ')}; could not read ${failed.join(', ')}. Clips in those formats may need converting to WAV or M4A first.${tail}`, details);
  return result(id, 'fail', 'Could not read even a WAV file. Importing clips will not work here; try Safari or Chrome.', details);
}

// ---------------------------------------------------------------------------------------------------------- indexeddb

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

const DIAG_DB = 'mimic-diagnostics';
const DIAG_BYTES = 5 * 1024 * 1024;

async function checkIndexedDb(): Promise<DiagnosticResult> {
  const id = 'indexeddb';
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return result(id, 'fail', 'Clip storage is not available here (private browsing, or a page that blocks it). Clips would only be kept until you close the app. Open Mimic in a normal Safari tab or from the Home Screen.', { available: false });
  }
  let db: IDBDatabase | null = null;
  try {
    const open = idb.open(DIAG_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('blobs');
    db = await withTimeout(idbRequest(open), 8000, null);
    if (!db) return result(id, 'fail', 'Clip storage did not answer in 8 seconds. Close other tabs of Mimic and reload; if it keeps happening, export a backup and restart Safari.', { available: true, answered: false });
    const data = new Uint8Array(DIAG_BYTES);
    for (let i = 0; i < data.length; i += 4099) data[i] = i & 255;
    let t0 = now();
    const tx = db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(data.buffer, 'probe');
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
    });
    const writeMs = now() - t0;
    t0 = now();
    const back = (await idbRequest(db.transaction('blobs', 'readonly').objectStore('blobs').get('probe'))) as ArrayBuffer | undefined;
    const readMs = now() - t0;
    const same = !!back && back.byteLength === DIAG_BYTES && new Uint8Array(back)[4099] === data[4099];
    const details: Details = { available: true, megabytes: 5, writeMs: round(writeMs, 0), readMs: round(readMs, 0), readBackMatches: same };
    return same
      ? result(id, 'ok', `Wrote and read back 5 MB in ${round(writeMs, 0)} ms and ${round(readMs, 0)} ms.`, details)
      : result(id, 'fail', 'Clip storage lost data in a test write. Clips may not survive: export a backup often and tell us.', details);
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? 'error';
    return result(id, name === 'QuotaExceededError' ? 'warn' : 'fail', name === 'QuotaExceededError' ? 'No room for a 5 MB test. Free some space on the device, then adding clips will work.' : `Clip storage failed (${name}). Reload the app; if it keeps happening, export a backup.`, { available: true, error: name });
  } finally {
    try {
      db?.close();
      idb.deleteDatabase(DIAG_DB);
    } catch {
      // Nothing more to clean.
    }
  }
}

// ------------------------------------------------------------------------------------------------------- analysis speed

async function checkAnalysisSpeed(): Promise<DiagnosticResult> {
  const id = 'analysis-speed';
  const demo = makeDemoTake();
  const sec = demo.samples.length / demo.sampleRate;
  const run = await measureStall(() => analyzeInWorker(demo.samples, demo.sampleRate, { voiceType: 'baritone' }));
  const perSec = run.ms / sec;
  const details: Details = { audioSec: round(sec), ms: round(run.ms, 0), msPerSecondOfAudio: round(perSec, 1), eightSecondPhraseMs: round(perSec * 8, 0), longestMainThreadGapMs: round(run.maxGapMs, 0) };
  if (perSec > 250) return result(id, 'warn', `Slow: ${round(perSec, 0)} ms per second of audio, so an 8 second phrase takes about ${round((perSec * 8) / 1000, 1)} s to score. Importing a long clip will take a while.`, details);
  return result(id, 'ok', `${round(sec)} s of audio analysed in ${round(run.ms / 1000, 2)} s (${round(perSec, 0)} ms per second). An 8 second phrase scores in about ${round((perSec * 8) / 1000, 1)} s.`, details);
}

// ------------------------------------------------------------------------------------------------------- stretch speed

async function checkStretchSpeed(): Promise<DiagnosticResult> {
  const id = 'stretch-speed';
  const sr = 44100;
  const secs = 12;
  const x = Float32Array.from({ length: secs * sr }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 196 * i) / sr) * (0.7 + 0.3 * Math.sin((2 * Math.PI * 5.5 * i) / sr)));
  const spec = { rate: 0.75, semitones: -5, outRate: 48000 };
  const viaWorker = await measureStall(() => renderGuideOffMainThread(x, sr, spec));
  // The same work in one go, on a 3 s excerpt scaled up (a 12 s one could freeze a slow phone for several seconds).
  const part = x.subarray(0, 3 * sr);
  const t0 = now();
  renderGuide(part, sr, spec);
  const oneGoMs = ((now() - t0) * secs) / 3;
  const details: Details = {
    phraseSec: secs,
    renderMs: round(viaWorker.ms, 0),
    ranInWorker: viaWorker.value.viaWorker,
    longestMainThreadGapMs: round(viaWorker.maxGapMs, 0),
    oneGoOnMainThreadMsScaled: round(oneGoMs, 0),
  };
  if (!viaWorker.value.viaWorker) return result(id, 'warn', `Web Workers are blocked here, so slowed and key-shifted guides render on the main thread in small slices (${round(viaWorker.ms, 0)} ms for a 12 second phrase). It works; choosing a key may stutter the screen briefly.`, details);
  if (viaWorker.maxGapMs > 50) return result(id, 'warn', `A 12 second phrase renders in ${round(viaWorker.ms, 0)} ms but the screen stalled for ${round(viaWorker.maxGapMs, 0)} ms meanwhile.`, details);
  return result(id, 'ok', `A 12 second phrase renders slowed and key-shifted in ${round(viaWorker.ms, 0)} ms without freezing the screen (longest stall ${round(viaWorker.maxGapMs, 0)} ms). In one go on the main thread it would take about ${round(oneGoMs, 0)} ms.`, details);
}

// ------------------------------------------------------------------------------------------------------------ route

async function checkRoute(): Promise<DiagnosticResult> {
  const id = 'route';
  const list = await listInputDevices();
  if (list === null) return result(id, 'warn', 'This browser cannot list microphones, so headphones cannot be told from the speaker. Choose Listen then sing, or Sing along with headphones you know are connected.', { listable: false });
  const route = describeRoute(
    list.map((d) => ({ kind: 'audioinput' as const, deviceId: d.id, label: d.label })),
    loadMicChoice() ?? '',
    0,
  );
  const notes = routeNotes(route, 'sing-along');
  const details: Details = {
    listable: true,
    microphones: route.inputs.length,
    namesHidden: !!route.labelsHidden,
    activeKind: route.kind,
    headphonesLikely: route.headphonesLikely,
    savedChoice: loadMicChoice() !== null,
    notes: notes.map((n) => n.id).join(',') || null,
  };
  const sensitive: string[] = [];
  route.inputs.forEach((d, i) => {
    details[`microphone.${i + 1}.kind`] = classifyRoute(d.label);
    details[`microphone.${i + 1}.name`] = d.label || '(hidden)';
    sensitive.push(`microphone.${i + 1}.name`);
  });
  if (route.inputs.length === 0) return result(id, 'warn', 'No microphone was found. Listening works; to sing, plug in a microphone or headphones with one.', details, sensitive);
  if (route.labelsHidden) return result(id, 'info', `${route.inputs.length} microphone${route.inputs.length === 1 ? '' : 's'}, names hidden until you allow the microphone once. Run the microphone level check, then run this again.`, details, sensitive);
  const warn = notes.find((n) => n.level === 'warn' && n.id !== 'speaker-sing-along');
  if (warn) return result(id, 'warn', warn.message, details, sensitive);
  return result(id, 'ok', route.headphonesLikely ? `${route.inputs.length} microphone${route.inputs.length === 1 ? '' : 's'}; headphones look connected, so Sing along is available.` : `${route.inputs.length} microphone${route.inputs.length === 1 ? '' : 's'}; no headphones detected, so the trainer will default to Listen then sing.`, details, sensitive);
}

// ----------------------------------------------------------------------------------------------------------- storage

async function checkStorage(): Promise<DiagnosticResult> {
  const id = 'storage';
  const s = await readStorageStatus();
  const standalone = isStandalone();
  const details: Details = {
    storageApi: s.api,
    persisted: s.persisted,
    usedBytes: s.usageBytes,
    quotaBytes: s.quotaBytes,
    installedToHomeScreen: standalone,
  };
  if (!s.api) return result(id, 'warn', 'This browser does not report storage. Clips are kept, but whether the browser may clear them cannot be checked. Add Mimic to the Home Screen and export a backup now and then.', details);
  const space = `${formatBytes(s.usageBytes)} used${s.quotaBytes ? ` of about ${formatBytes(s.quotaBytes)}` : ''}`;
  if (s.persisted === true) return result(id, 'ok', `Persistent storage is on (${space}).`, details);
  if (ios() && !standalone) return result(id, 'warn', `${space}. Safari clears a website's data after about a week of not using it. Add Mimic to the Home Screen to keep your clips.`, details);
  return result(id, 'info', `${space}. The browser may clear the data if the device runs low on space. Export a backup now and then.`, details);
}

// ----------------------------------------------------------------------------------------------------- display mode

/** "iOS 18.4", "Android 14", "macOS", from the user agent: only for the report. */
export function describeUserAgent(ua: string): string {
  const m = /OS (\d+)[_.](\d+)(?:[_.](\d+))?/.exec(ua);
  if (/iPhone|iPad|iPod/.test(ua) && m) return `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${m[1]}.${m[2]}`;
  const a = /Android (\d+(?:\.\d+)?)/.exec(ua);
  if (a) return `Android ${a[1]}`;
  if (/Macintosh/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'unknown system';
}

function mediaMatches(query: string): boolean | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia(query).matches : null;
  } catch {
    return null;
  }
}

async function checkDisplayMode(): Promise<DiagnosticResult> {
  const id = 'display-mode';
  const env = readEnv();
  const g = globalThis as unknown as Record<string, unknown>;
  const nav = (globalThis.navigator ?? {}) as Navigator & { wakeLock?: unknown; share?: unknown; serviceWorker?: unknown; clipboard?: unknown };
  const standalone = isStandalone(env);
  const secure = g.isSecureContext !== false;
  const system = describeUserAgent(env.userAgent);
  const details: Details = {
    system,
    userAgent: env.userAgent,
    standalone,
    secureContext: secure,
    touchPoints: env.maxTouchPoints,
    viewport: typeof innerWidth === 'number' ? `${innerWidth} x ${innerHeight}` : null,
    pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : null,
    reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
    darkMode: mediaMatches('(prefers-color-scheme: dark)'),
    webWorker: typeof Worker !== 'undefined',
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    mediaRecorder: typeof g.MediaRecorder !== 'undefined',
    wakeLock: !!nav.wakeLock,
    serviceWorker: !!nav.serviceWorker,
    webShare: typeof nav.share === 'function',
    clipboard: !!nav.clipboard,
    getUserMedia: !!nav.mediaDevices?.getUserMedia,
  };
  const where = standalone ? 'running from the Home Screen' : 'running in a browser tab';
  if (!secure) return result(id, 'fail', `${system}, ${where}, but this page is not secure (https), so the microphone is blocked. Open Mimic from its https address.`, details);
  if (!details.getUserMedia) return result(id, 'warn', `${system}, ${where}. This page cannot use a microphone (a frame or an old browser): listening works, uploading a voice memo works.`, details);
  return result(id, 'info', `${system}, ${where}.${ios() && !standalone ? ' Add Mimic to the Home Screen for storage that is not cleared after a week.' : ''}`, details);
}

// ---------------------------------------------------------------------------------------------------------- click probe

function recorderMessage(e: unknown): string {
  return e instanceof RecorderError ? e.message : e instanceof Error ? e.message : String(e);
}

async function checkClickProbe(opts: RunOptions): Promise<DiagnosticResult> {
  const id = 'click-probe';
  const session = createDuplexSession();
  try {
    opts.onProgress?.({ fraction: 0.05, message: 'Starting the microphone. Allow it if asked.' });
    const route = await session.prepare({ mic: true });
    const ctx = session.context;
    const silent = ctx.createBuffer(1, Math.round(0.3 * ctx.sampleRate), ctx.sampleRate);
    opts.onProgress?.({ fraction: 0.3, message: 'Playing four clicks. Hold an earbud against the microphone, or use the speaker.' });
    // Uneven spacing: a steady beat or hum in the room (or a fake microphone's beep) must not pass for the clicks.
    const take = session.runTake(silent, { mode: 'turn-taking', countInBeats: 4, bpm: 120, tailSec: 0, turnSec: 0.4, gain: 0, clickGain: 0.7, clickOffsetsSec: [0, 0.37, 0.84, 1.3] });
    const onAbort = (): void => take.stop();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const r = await take.done.finally(() => opts.signal?.removeEventListener('abort', onAbort));
    opts.onProgress?.({ fraction: 1 });
    const probe = probeClicks(r.samples, r.sampleRate, r.clickTimesInCaptureSec);
    const details: Details = {
      routeKind: route.kind,
      clicksHeard: probe.clicksHeard,
      clicksPlayed: probe.clicksTried,
      roundTripMs: probe.roundTripMs === null ? null : round(probe.roundTripMs, 0),
      delaysAgree: probe.consistent,
      clickOverRoomDb: round(probe.clickOverFloorDb, 0),
      roomNoiseDbfs: round(probe.floorDb, 0),
      droppedFrames: r.droppedFrames,
      clockExact: r.clockExact ?? null,
      endedBy: r.endedBy,
    };
    if (r.endedBy === 'interrupted') return result(id, 'warn', `The test was interrupted (${r.interruptedBy ?? 'unknown'}). Keep the app open and the screen on, then run it again.`, details);
    if (r.droppedFrames > MAX_DROPPED_SEC * r.sampleRate) return result(id, 'warn', 'The recording had gaps, so the test is not reliable. Close other apps and run it again.', details);
    if (probe.roundTripMs === null) {
      return result(id, 'info', 'No click was heard. That is normal with headphones on your head (nothing leaks to the microphone). To measure the delay, hold an earbud against the iPhone microphone, or use the speaker at a higher volume, and run it again.', details);
    }
    if (!probe.consistent) return result(id, 'info', `Something was heard but the delays disagree, so this is not a clean reading. Try again in a quieter room with the earbud closer to the microphone.`, details);
    const ms = round(probe.roundTripMs, 0);
    if (ms > 250) return result(id, 'warn', `Round trip about ${ms} ms (playing, the air and recording together). That is a lot: it looks like Bluetooth. Wired headphones, or the iPhone microphone with Listen then sing, will line up better.`, details);
    return result(id, 'ok', `Round trip about ${ms} ms (playing, the air and recording together). The trainer does not count this against you.`, details);
  } catch (e) {
    return result(id, 'fail', recorderMessage(e), { error: recorderMessage(e) });
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------------------------------------- mic level

interface MediaRecorderLike {
  start(): void;
  stop(): void;
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
}

/** Records ~1.5 s from the same stream with MediaRecorder and decodes it again: does this device read what it writes? */
async function recorderRoundTrip(stream: MediaStream, details: Details): Promise<void> {
  const MR = (globalThis as unknown as { MediaRecorder?: new (s: MediaStream, o?: { mimeType?: string }) => MediaRecorderLike }).MediaRecorder;
  const Ctor = audioContextCtor();
  if (!MR || !Ctor) {
    details['roundTrip'] = 'MediaRecorder is not available';
    return;
  }
  const rec = new MR(stream);
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) parts.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    rec.onstop = () => resolve();
    rec.onerror = () => resolve();
  });
  rec.start();
  await sleep(1500);
  if (rec.state !== 'inactive') rec.stop();
  await withTimeout(stopped, 3000, undefined);
  const blob = new Blob(parts, { type: rec.mimeType || undefined });
  details['roundTrip.mimeType'] = rec.mimeType || '(unknown)';
  details['roundTrip.bytes'] = blob.size;
  if (blob.size === 0) {
    details['roundTrip'] = 'the recorder produced nothing';
    return;
  }
  const ctx = new Ctor();
  try {
    const buf = await withTimeout(decodeBytes(ctx, await blob.arrayBuffer()), 5000, null);
    details['roundTrip'] = buf ? `decoded ${round(buf.duration, 2)} s at ${buf.sampleRate} Hz` : 'the device could not read what it just recorded';
  } catch (e) {
    details['roundTrip'] = `decode failed (${(e as { name?: string } | null)?.name ?? 'error'})`;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function checkMicLevel(opts: RunOptions): Promise<DiagnosticResult> {
  const id = 'mic-level';
  const seconds = Math.max(1, opts.seconds ?? 10);
  const session = createDuplexSession();
  try {
    opts.onProgress?.({ fraction: 0, message: 'Starting the microphone. Allow it if asked.' });
    const route = await session.prepare({ mic: true });
    const analyser = session.analyser;
    if (!analyser) return result(id, 'fail', 'The microphone opened but gave no signal to measure. Reload the app and try again.', {});
    const buf = new Float32Array(analyser.fftSize);
    const blocksDb: number[] = [];
    let peak = 0;
    let clipped = 0;
    let total = 0;
    const start = now();
    opts.onProgress?.({ fraction: 0, message: 'Say "la la la" at singing volume for 10 seconds, then stay quiet for the last two.' });
    while (now() - start < seconds * 1000) {
      if (opts.signal?.aborted) break;
      await sleep(50);
      analyser.getFloatTimeDomainData(buf);
      const lv = blockLevel(buf);
      blocksDb.push(lv.rmsDb);
      peak = Math.max(peak, lv.peak);
      for (let i = 0; i < buf.length; i++) if (Math.abs(buf[i]) >= 0.99) clipped++;
      total += buf.length;
      const frac = Math.min(1, (now() - start) / (seconds * 1000));
      opts.onProgress?.({ fraction: frac, level: Math.max(0, Math.min(1, (lv.rmsDb + 60) / 60)), message: LEVEL_TEXT[levelState(lv.rmsDb, lv.peak)] });
    }
    const sorted = [...blocksDb].sort((a, b) => a - b);
    const at = (p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -120);
    const floor = at(0.1);
    const loud = at(0.9);
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
    const details: Details = {
      seconds: round((now() - start) / 1000),
      peakDbfs: round(peakDb, 0),
      loudRmsDbfs: round(loud, 0),
      roomNoiseDbfs: round(floor, 0),
      clippedPercent: total ? round((clipped / total) * 100, 2) : 0,
      state: levelState(loud, peak),
      sampleRateHz: route.sampleRate,
      inputSampleRateHz: route.inputSampleRate ?? null,
      routeKind: route.kind,
      deviceName: route.inputLabel || null,
    };
    if (opts.signal?.aborted) return result(id, 'info', 'Stopped before it finished.', details, ['deviceName']);
    opts.onProgress?.({ fraction: 1, message: 'Checking that this device can read what it records.' });
    // Same stream is not exposed by the session, so the round trip opens its own for a moment.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      try {
        await recorderRoundTrip(s, details);
      } finally {
        s.getTracks().forEach((t) => t.stop());
      }
    } catch {
      details['roundTrip'] = 'could not open a second recording';
    }
    const state = levelState(loud, peak);
    if (details.clippedPercent !== null && (details.clippedPercent as number) > 0.1) return result(id, 'warn', `Too loud: the signal hit full scale in ${details.clippedPercent}% of the samples. Hold the phone farther away.`, details, ['deviceName']);
    if (loud < -50) return result(id, 'warn', `Very quiet: singing-level sound reached only ${round(loud, 0)} dBFS. Move closer, or check the right microphone is selected.`, details, ['deviceName']);
    if (state === 'quiet') return result(id, 'warn', `Quiet: ${round(loud, 0)} dBFS at singing level. Move closer or sing out a little.`, details, ['deviceName']);
    if (floor > -45) return result(id, 'warn', `The room is noisy (${round(floor, 0)} dBFS when you were quiet). Find a quieter spot for the best scores.`, details, ['deviceName']);
    return result(id, 'ok', `Singing level ${round(loud, 0)} dBFS (peak ${round(peakDb, 0)}), room noise ${round(floor, 0)} dBFS.`, details, ['deviceName']);
  } catch (e) {
    return result(id, 'fail', recorderMessage(e), { error: recorderMessage(e) });
  } finally {
    await session.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------------------------------------- the runner

/** Runs one check. Never rejects for a failing device: that is a result with status 'fail'. */
export async function runDiagnostic(id: DiagnosticId, opts: RunOptions = {}): Promise<DiagnosticResult> {
  try {
    switch (id) {
      case 'audio-context':
        return await checkAudioContext();
      case 'audio-session':
        return await checkAudioSession();
      case 'decode':
        return await checkDecode();
      case 'indexeddb':
        return await checkIndexedDb();
      case 'analysis-speed':
        return await checkAnalysisSpeed();
      case 'stretch-speed':
        return await checkStretchSpeed();
      case 'click-probe':
        return await checkClickProbe(opts);
      case 'route':
        return await checkRoute();
      case 'storage':
        return await checkStorage();
      case 'display-mode':
        return await checkDisplayMode();
      case 'mic-level':
        return await checkMicLevel(opts);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return result(id, 'fail', `This check could not run: ${msg}`, { error: msg });
  }
  return result(id, 'fail', 'Unknown check.', {});
}

/** The quick checks in order, each result reported as it arrives. A failing one does not stop the rest. */
export async function runQuickDiagnostics(opts: { signal?: AbortSignal; onResult?: (r: DiagnosticResult) => void } = {}): Promise<DiagnosticResult[]> {
  const out: DiagnosticResult[] = [];
  for (const id of QUICK_DIAGNOSTICS) {
    if (opts.signal?.aborted) break;
    const r = await runDiagnostic(id);
    out.push(r);
    opts.onResult?.(r);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------- device checklist

export type ChecklistAnswer = 'pass' | 'fail' | 'skip';

export interface ChecklistItem {
  id: string;
  title: string;
  /** What to do, one tap or action per line. */
  steps: string[];
  /** What should happen. The person answers pass / fail / skip against this. */
  expect: string;
  /** Needs a particular kind of gear. */
  needs?: string;
}

/** Things only a person holding a real iPhone can find out. Plain English, in the order that is easiest to do. */
export const DEVICE_CHECKLIST: readonly ChecklistItem[] = [
  {
    id: 'silent-switch',
    title: 'The guide plays with the side switch on silent',
    steps: ['Flip the small switch on the side of the iPhone so the orange shows (silent).', 'Open a phrase in the Trainer and tap Listen.'],
    expect: 'You hear the phrase. If you hear nothing, answer fail.',
  },
  {
    id: 'headphones-listen',
    title: 'Sound goes to the headphones',
    steps: ['Plug in headphones or connect AirPods.', 'Tap Listen on a phrase.'],
    expect: 'The phrase plays in the headphones and not from the phone speaker.',
    needs: 'headphones',
  },
  {
    id: 'sing-along-wired',
    title: 'Sing along with headphones on',
    steps: ['Put the headphones on.', 'Choose Sing along and tap Sing.', 'Listen for the clicks, then sing with the guide to the end.'],
    expect: 'Three clicks, then the guide, then a score within about two seconds of finishing. Note the sync offset the result shows.',
    needs: 'headphones',
  },
  {
    id: 'bluetooth-mic',
    title: 'AirPods: the Bluetooth warning',
    steps: ['Wear AirPods (or another Bluetooth headset).', 'Tap Sing.'],
    expect: 'The app says a Bluetooth microphone is in use and offers the iPhone microphone. After you choose it, the guide still plays in the AirPods.',
    needs: 'AirPods or a Bluetooth headset',
  },
  {
    id: 'speaker-default',
    title: 'No headphones: the speaker is not trusted',
    steps: ['Unplug or disconnect all headphones.', 'Open a phrase.'],
    expect: 'The app picks Listen then sing, and warns if you switch to Sing along.',
  },
  {
    id: 'interrupt-call',
    title: 'A call or Siri during a take',
    steps: ['Tap Sing.', 'During the clicks, call the iPhone, or say "Hey Siri", or let an alarm go off.'],
    expect: 'The take is cancelled with a message that says what to do, not scored, and Try again works afterwards.',
  },
  {
    id: 'leave-app',
    title: 'Leaving the app during a take',
    steps: ['Tap Sing.', 'Swipe up to the Home Screen while the clicks play, then come back.'],
    expect: 'The take is cancelled with a message, nothing is scored, and the app still works.',
  },
  {
    id: 'unplug',
    title: 'Pulling the headphones out during a take',
    steps: ['Plug in wired headphones, tap Sing, and unplug them during the clicks.'],
    expect: 'The take is cancelled with a message that names what changed.',
    needs: 'wired headphones',
  },
  {
    id: 'screen-stays-on',
    title: 'The screen stays on while you practise',
    steps: ['Leave a phrase open for a minute without touching the screen.'],
    expect: 'The screen does not dim or lock while you are on the practice screen (iOS 18.4 or newer).',
  },
  {
    id: 'voice-memo',
    title: 'Adding a Voice Memo',
    steps: ['In Voice Memos, share a recording and choose Save to Files.', 'In Mimic, Trainer, Add clips, and pick that file.'],
    expect: 'It imports. If it says it cannot read the file, answer fail and say which iOS version this is.',
  },
  {
    id: 'home-screen',
    title: 'Home Screen app keeps your clips',
    steps: ['Add Mimic to the Home Screen and open it from there.', 'Add a clip, close the app completely, and open it again the next day.'],
    expect: 'The clip is still there. Note whether the microphone asks for permission again.',
  },
];

// ------------------------------------------------------------------------------------------------------------ report

export interface ReportMeta {
  /** Build or version text of the app. */
  appVersion?: string;
  at?: Date;
  /** Put the names of microphones into the report (off by default: a name like "Raj's AirPods" says who you are). */
  includeLabels?: boolean;
  checklist?: Record<string, ChecklistAnswer>;
  notes?: string;
}

/** Plain-text report for the clipboard. */
export function formatDiagnostics(results: DiagnosticResult[], meta: ReportMeta = {}): string {
  const lines: string[] = [];
  lines.push('Mimic Vocal Coach: device report');
  lines.push(`Made: ${(meta.at ?? new Date()).toISOString()}`);
  if (meta.appVersion) lines.push(`App: ${meta.appVersion}`);
  lines.push('This report holds no audio and no recordings.' + (meta.includeLabels ? '' : ' Microphone names are left out.'));
  lines.push('');
  for (const r of results) {
    lines.push(`${r.label}: ${r.status.toUpperCase()} - ${r.summary}`);
    const hidden = new Set(meta.includeLabels ? [] : (r.sensitive ?? []));
    for (const [k, v] of Object.entries(r.details)) {
      if (hidden.has(k)) continue;
      lines.push(`    ${k}: ${v === null ? '-' : String(v)}`);
    }
  }
  const answered = meta.checklist ? DEVICE_CHECKLIST.filter((c) => meta.checklist?.[c.id]) : [];
  if (answered.length) {
    lines.push('');
    lines.push('Checklist on the device:');
    for (const c of answered) lines.push(`    ${(meta.checklist?.[c.id] ?? 'skip').toUpperCase().padEnd(5)} ${c.title}`);
  }
  if (meta.notes?.trim()) {
    lines.push('');
    lines.push('Notes:');
    lines.push(meta.notes.trim());
  }
  return lines.join('\n');
}
