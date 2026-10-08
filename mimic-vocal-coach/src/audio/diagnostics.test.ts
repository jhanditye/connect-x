import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInWorker } from '../analysis/client';
import { renderGuideOffMainThread, type GuideRender } from '../dsp/stretchClient';
import { installFakeAudio, runFor, type FakeAudio } from '../testing/fakeAudio';
import {
  DEVICE_CHECKLIST,
  DIAGNOSTIC_IDS,
  DIAGNOSTIC_LABELS,
  describeUserAgent,
  formatDiagnostics,
  INTERACTIVE_DIAGNOSTICS,
  makeTestAiff,
  makeTestCaf,
  makeTestMp3,
  makeTestWav,
  QUICK_DIAGNOSTICS,
  runDiagnostic,
  runQuickDiagnostics,
  type DiagnosticResult,
} from './diagnostics';

vi.mock('../analysis/client', () => ({ analyzeInWorker: vi.fn(async () => ({}) as never) }));
vi.mock('../dsp/stretchClient', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../dsp/stretchClient')>();
  return { ...orig, renderGuideOffMainThread: vi.fn(orig.renderGuideOffMainThread) };
});

let env: FakeAudio | null = null;
function fake(options: Parameters<typeof installFakeAudio>[0] = {}): FakeAudio {
  env = installFakeAudio({ startSuspended: false, ...options });
  return env;
}
const setNav = (patch: Record<string, unknown>): void => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) Object.defineProperty(nav, k, { value: v, configurable: true, writable: true });
};

beforeEach(() => {
  vi.mocked(analyzeInWorker).mockClear();
});

afterEach(() => {
  env?.restore();
  env = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs an interactive check while the fake audio clock and the timers advance. */
async function runInteractive(e: FakeAudio, start: () => Promise<DiagnosticResult>, maxSec = 30): Promise<DiagnosticResult> {
  vi.useFakeTimers();
  let out: DiagnosticResult | null = null;
  void start().then((r) => (out = r));
  for (let i = 0; i < maxSec * 20 && !out; i++) await runFor(e, 0.05, (ms) => vi.advanceTimersByTimeAsync(ms));
  if (!out) throw new Error('the check never finished');
  return out;
}

describe('the lists', () => {
  it('every id has a label and the quick and interactive lists cover them all exactly once', () => {
    for (const id of DIAGNOSTIC_IDS) expect(DIAGNOSTIC_LABELS[id].length).toBeGreaterThan(3);
    const all = [...QUICK_DIAGNOSTICS, ...INTERACTIVE_DIAGNOSTICS].sort();
    expect(all).toEqual([...DIAGNOSTIC_IDS].sort());
    expect(new Set(DIAGNOSTIC_IDS).size).toBe(DIAGNOSTIC_IDS.length);
  });
});

describe('the test files', () => {
  it('WAV, AIFF, CAF and MP3 have the structure their decoders look for', () => {
    const tag = (b: ArrayBuffer, o: number): string => String.fromCharCode(...new Uint8Array(b, o, 4));
    const wav = makeTestWav();
    expect([tag(wav, 0), tag(wav, 8)]).toEqual(['RIFF', 'WAVE']);

    const aiff = makeTestAiff();
    expect([tag(aiff, 0), tag(aiff, 8), tag(aiff, 12), tag(aiff, 38)]).toEqual(['FORM', 'AIFF', 'COMM', 'SSND']);
    const v = new DataView(aiff);
    expect(v.getUint32(4)).toBe(aiff.byteLength - 8);
    expect(Array.from(new Uint8Array(aiff, 28, 10))).toEqual([0x40, 0x0d, 0xac, 0x44, 0, 0, 0, 0, 0, 0]); // 22050 Hz as an 80-bit float
    expect(v.getUint32(22)).toBe(Math.round(0.25 * 22050)); // frames, checked against the data size below
    expect(v.getUint32(42)).toBe(8 + v.getUint32(22) * 2);

    const caf = makeTestCaf();
    expect([tag(caf, 0), tag(caf, 8), tag(caf, 28), tag(caf, 52)]).toEqual(['caff', 'desc', 'lpcm', 'data']);
    const c = new DataView(caf);
    expect(c.getFloat64(20)).toBe(22050);
    expect(Number(c.getBigInt64(56))).toBe(caf.byteLength - 64);

    const mp3 = new Uint8Array(makeTestMp3());
    expect(mp3.length).toBe(417 * 10);
    for (let i = 0; i < 10; i++) expect(Array.from(mp3.subarray(i * 417, i * 417 + 4))).toEqual([0xff, 0xfb, 0x90, 0xc0]);
  });
});

describe('describeUserAgent', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 'iOS 18.4'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15', 'iPadOS 17.5'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', 'Android 14'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux'],
    ['', 'unknown system'],
  ])('%s', (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });
});

describe('audio-context', () => {
  it('reports the engine and closes the context it opened', async () => {
    const e = fake({ sampleRate: 48000 });
    const r = await runDiagnostic('audio-context');
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ webAudio: true, sampleRateHz: 48000, stateAfterResume: 'running', audioWorklet: true, maxOutputChannels: 2 });
    expect(r.summary).toMatch(/48 kHz/);
    expect(e.contexts).toHaveLength(1);
    expect(e.contexts[0].closeCalls).toBe(1);
  });

  it('warns when the browser did not start the engine', async () => {
    fake({ startSuspended: true, resumeNeverSettles: true });
    vi.useFakeTimers();
    const p = runDiagnostic('audio-context');
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/tap Run again/);
  });

  it('warns about a missing AudioWorklet and a low sample rate, fails with no Web Audio at all', async () => {
    fake({ worklet: false });
    expect((await runDiagnostic('audio-context')).summary).toMatch(/no AudioWorklet/);
    env?.restore();
    fake({ sampleRate: 22050 });
    expect((await runDiagnostic('audio-context')).summary).toMatch(/22.05 kHz/);
    Object.defineProperty(globalThis, 'AudioContext', { value: undefined, configurable: true, writable: true });
    const r = await runDiagnostic('audio-context');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/no Web Audio/);
  });
});

describe('audio-session', () => {
  it('present: checks it can be set and puts the old value back', async () => {
    const e = fake();
    const r = await runDiagnostic('audio-session');
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ present: true, canSetPlayback: true });
    expect(e.sessionTypes).toEqual(['playback', 'auto']);
  });

  it('absent: info elsewhere, a warning on iOS', async () => {
    fake({ audioSession: false });
    expect((await runDiagnostic('audio-session')).status).toBe('info');
    setNav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' });
    const r = await runDiagnostic('audio-session');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/silent/);
  });

  it('refusing the playback type is a warning', async () => {
    const e = fake();
    const session = (e as unknown as { session: { type: string } }).session;
    Object.defineProperty(session, 'type', { get: () => 'auto', set: () => undefined, configurable: true });
    const r = await runDiagnostic('audio-session');
    expect(r.status).toBe('warn');
    expect(r.details.canSetPlayback).toBe(false);
  });
});

describe('decode', () => {
  const stubAudioElement = (answers: Record<string, string>): void => {
    vi.stubGlobal('document', { createElement: () => ({ canPlayType: (t: string) => answers[t] ?? '' }) });
  };

  it('all four test files decode: ok, with what else the browser says it can play', async () => {
    fake();
    stubAudioElement({ 'audio/flac': 'probably', 'audio/mp4; codecs="mp4a.40.2"': 'maybe' });
    const r = await runDiagnostic('decode');
    expect(r.status).toBe('ok');
    expect(r.details['decode.wav']).toMatch(/^ok/);
    expect(r.details['decode.caf']).toMatch(/^ok/);
    expect(r.details['play.flac']).toBe('probably');
    expect(r.details['play.opus']).toBe('no');
    expect(r.summary).toMatch(/FLAC/);
    expect(r.summary).toMatch(/AAC in M4A/);
  });

  it('a format that fails is named, with what to do', async () => {
    fake({ decodes: ['wav', 'mp3'] });
    const r = await runDiagnostic('decode');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/could not read AIFF, CAF/);
    expect(r.summary).toMatch(/converting/);
    expect(r.details['decode.aiff']).toMatch(/failed \(EncodingError\)/);
  });

  it('not even WAV: fail', async () => {
    fake({ decodes: [] });
    const r = await runDiagnostic('decode');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/even a WAV/);
  });

  it('a decoder that never answers does not hang the check', async () => {
    const e = fake();
    vi.useFakeTimers();
    (globalThis.AudioContext as unknown as { prototype: { decodeAudioData: unknown } }).prototype.decodeAudioData = () => new Promise(() => undefined);
    const p = runDiagnostic('decode');
    await vi.advanceTimersByTimeAsync(20000);
    const r = await p;
    expect(r.status).toBe('fail');
    expect(r.details['decode.wav']).toMatch(/no answer/);
    expect(e.contexts[0].closeCalls).toBe(1);
  });
});

describe('indexeddb', () => {
  it('not available: fail with the way out', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const r = await runDiagnostic('indexeddb');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/Home Screen/);
  });

  /** The smallest IndexedDB that can do open / put / get / deleteDatabase. */
  function installIdb(opts: { failPut?: string; hang?: boolean } = {}) {
    const stores = new Map<string, Map<string, unknown>>();
    const deleted: string[] = [];
    const req = <T>(value: T, fail?: string) => {
      const r: { result: T; error: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null } = { result: value, error: fail ? Object.assign(new Error(fail), { name: fail }) : null, onsuccess: null, onerror: null };
      setTimeout(() => (fail ? r.onerror?.() : r.onsuccess?.()), 0);
      return r;
    };
    const db = {
      createObjectStore: (name: string) => stores.set(name, new Map()),
      transaction: (name: string) => {
        const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; error: unknown; objectStore: (n: string) => unknown } = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          objectStore: () => ({
            put: (v: unknown, k: string) => {
              if (opts.failPut) {
                tx.error = Object.assign(new Error(opts.failPut), { name: opts.failPut });
                setTimeout(() => tx.onabort?.(), 0);
              } else {
                stores.get(name)?.set(k, v);
                setTimeout(() => tx.oncomplete?.(), 0);
              }
            },
            get: (k: string) => req(stores.get(name)?.get(k)),
          }),
        };
        return tx;
      },
      close: vi.fn(),
    };
    const factory = {
      open: () => {
        const r = { result: db, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onupgradeneeded: null as (() => void) | null };
        if (!opts.hang)
          setTimeout(() => {
            r.onupgradeneeded?.();
            r.onsuccess?.();
          }, 0);
        return r;
      },
      deleteDatabase: (name: string) => deleted.push(name),
    };
    vi.stubGlobal('indexedDB', factory);
    return { db, deleted };
  }

  it('writes and reads back 5 MB, then deletes its database', async () => {
    const { db, deleted } = installIdb();
    const r = await runDiagnostic('indexeddb');
    expect(r.status).toBe('ok');
    expect(r.details).toMatchObject({ available: true, megabytes: 5, readBackMatches: true });
    expect(db.close).toHaveBeenCalled();
    expect(deleted).toEqual(['mimic-diagnostics']);
  });

  it('a full disk is a warning, any other failure is a fail, and the database is still cleaned up', async () => {
    const full = installIdb({ failPut: 'QuotaExceededError' });
    const r1 = await runDiagnostic('indexeddb');
    expect(r1.status).toBe('warn');
    expect(r1.summary).toMatch(/Free some space/);
    expect(full.deleted).toEqual(['mimic-diagnostics']);
    const bad = installIdb({ failPut: 'UnknownError' });
    const r2 = await runDiagnostic('indexeddb');
    expect(r2.status).toBe('fail');
    expect(r2.summary).toMatch(/export a backup/);
    expect(bad.deleted).toEqual(['mimic-diagnostics']);
  });

  it('a database that never opens ends the check after eight seconds', async () => {
    installIdb({ hang: true });
    vi.useFakeTimers();
    const p = runDiagnostic('indexeddb');
    await vi.advanceTimersByTimeAsync(8100);
    const r = await p;
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/8 seconds/);
  });
});

describe('analysis-speed and stretch-speed', () => {
  it('analysis speed reports per-second cost and an estimate for an 8 second phrase', async () => {
    const r = await runDiagnostic('analysis-speed');
    expect(r.status).toBe('ok');
    expect(analyzeInWorker).toHaveBeenCalledTimes(1);
    expect(Number(r.details.audioSec)).toBeGreaterThan(10);
    expect(r.details).toHaveProperty('eightSecondPhraseMs');
    expect(r.summary).toMatch(/8 second phrase/);
  });

  it('an analysis that throws is a failed check, not a crash', async () => {
    vi.mocked(analyzeInWorker).mockRejectedValueOnce(new Error('worker blew up'));
    const r = await runDiagnostic('analysis-speed');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/worker blew up/);
  });

  it('without a worker the render happens in slices on the main thread: ok but flagged', async () => {
    const r = await runDiagnostic('stretch-speed');
    expect(r.details.ranInWorker).toBe(false);
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Web Workers are blocked/);
    expect(r.details).toHaveProperty('oneGoOnMainThreadMsScaled');
  });

  it('with a worker it is ok and says the screen did not freeze', async () => {
    vi.mocked(renderGuideOffMainThread).mockImplementationOnce(async () => ({ samples: new Float32Array(10), sampleRate: 48000, viaWorker: true, ms: 12 }) as GuideRender);
    const r = await runDiagnostic('stretch-speed');
    expect(r.status).toBe('ok');
    expect(r.details.ranInWorker).toBe(true);
    expect(r.summary).toMatch(/without freezing/);
  });
});

describe('route', () => {
  it('headphones absent: ok, tells the trainer will default to Listen then sing, names hidden from the report', async () => {
    fake();
    const r = await runDiagnostic('route');
    expect(r.status).toBe('ok');
    expect(r.summary).toMatch(/Listen then sing/);
    expect(r.details).toMatchObject({ microphones: 1, activeKind: 'builtin', headphonesLikely: false, namesHidden: false });
    expect(r.sensitive).toEqual(['microphone.1.name']);
    expect(r.details['microphone.1.name']).toBe('iPhone Microphone');
  });

  it('Bluetooth microphone in use: a warning that says what to do', async () => {
    fake({ devices: [{ deviceId: 'a', label: "Raj's AirPods", kind: 'audioinput' }, { deviceId: 'b', label: 'iPhone Microphone', kind: 'audioinput' }] });
    const r = await runDiagnostic('route');
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Bluetooth/);
    expect(r.summary).toMatch(/iPhone microphone/);
  });

  it('names hidden before permission: info that says what to do next', async () => {
    fake({ devices: [{ deviceId: 'a', label: '', kind: 'audioinput' }] });
    const r = await runDiagnostic('route');
    expect(r.status).toBe('info');
    expect(r.summary).toMatch(/microphone level check/);
  });

  it('no microphone and no device list are each said plainly', async () => {
    fake({ devices: [{ deviceId: 'o', label: 'Speaker', kind: 'audiooutput' }] });
    expect((await runDiagnostic('route')).summary).toMatch(/No microphone was found/);
    setNav({ mediaDevices: undefined });
    expect((await runDiagnostic('route')).summary).toMatch(/cannot list microphones/);
  });
});

describe('storage and display mode', () => {
  it('storage: persistent is ok; unprotected Safari tab is a warning that names Add to Home Screen', async () => {
    fake();
    setNav({ storage: { persisted: async () => true, estimate: async () => ({ usage: 5e7, quota: 5e9 }), persist: async () => true } });
    const ok = await runDiagnostic('storage');
    expect(ok.status).toBe('ok');
    expect(ok.details).toMatchObject({ persisted: true, usedBytes: 5e7 });
    setNav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Version/18.4 Mobile Safari/604.1', storage: { persisted: async () => false, estimate: async () => ({ usage: 1e6, quota: 1e9 }) } });
    const warn = await runDiagnostic('storage');
    expect(warn.status).toBe('warn');
    expect(warn.summary).toMatch(/Home Screen/);
    setNav({ storage: undefined });
    expect((await runDiagnostic('storage')).status).toBe('warn');
  });

  it('display mode: system, home screen or tab, and what the page can do', async () => {
    fake();
    setNav({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Version/18.4 Mobile Safari/604.1', platform: 'iPhone', standalone: true });
    const r = await runDiagnostic('display-mode');
    expect(r.status).toBe('info');
    expect(r.summary).toMatch(/iOS 18.4, running from the Home Screen/);
    expect(r.details).toMatchObject({ standalone: true, audioWorklet: true, getUserMedia: true, secureContext: true });
  });

  it('display mode: an insecure page cannot use the microphone', async () => {
    fake();
    vi.stubGlobal('isSecureContext', false);
    const r = await runDiagnostic('display-mode');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/https/);
    setNav({ mediaDevices: undefined });
    vi.stubGlobal('isSecureContext', true);
    expect((await runDiagnostic('display-mode')).status).toBe('warn');
  });
});

describe('click-probe (through the real session on the fake world)', () => {
  it('speaker with a 90 ms delay: ok, reads the round trip', async () => {
    const e = fake({ latencySec: 0.09, leak: 0.4 });
    const r = await runInteractive(e, () => runDiagnostic('click-probe'));
    expect(r.status).toBe('ok');
    expect(Math.abs(Number(r.details.roundTripMs) - 90)).toBeLessThan(6);
    expect(r.details).toMatchObject({ clicksHeard: 4, clicksPlayed: 4, delaysAgree: true, droppedFrames: 0 });
    expect(e.contexts.every((c) => c.state === 'closed')).toBe(true);
  });

  it('sealed headphones: nothing heard, info that explains what to do', async () => {
    const e = fake({ latencySec: 0.09, leak: 0 });
    const r = await runInteractive(e, () => runDiagnostic('click-probe'));
    expect(r.status).toBe('info');
    expect(r.summary).toMatch(/No click was heard/);
    expect(r.summary).toMatch(/hold an earbud/);
  });

  it('a steady beat in the room at the same pace as the clicks is not mistaken for them', async () => {
    // An impulse train every 0.5 s: with evenly spaced clicks every window would hold one at the same delay.
    const e = fake({
      mic: (frame, n, sr) =>
        Float32Array.from({ length: n }, (_, i) => {
          const t = (frame + i) / sr;
          const phase = t % 0.5;
          return phase > 0.079 && phase < 0.083 ? 0.8 * Math.sin(2 * Math.PI * 2000 * phase) : 0.0003 * Math.sin(i);
        }),
    });
    const r = await runInteractive(e, () => runDiagnostic('click-probe'));
    expect(r.status).not.toBe('ok');
    expect(r.details.delaysAgree).toBe(false);
  });

  it('a gap in the recording makes the reading unreliable, unless it is only a few milliseconds', async () => {
    const run = async (glitchSec: number): Promise<DiagnosticResult> => {
      const e = fake({ latencySec: 0.09, leak: 0.4 });
      vi.useFakeTimers();
      let out: DiagnosticResult | null = null;
      void runDiagnostic('click-probe').then((r) => (out = r));
      await runFor(e, 1.2, (ms) => vi.advanceTimersByTimeAsync(ms));
      e.glitch(glitchSec);
      for (let i = 0; i < 200 && !out; i++) await runFor(e, 0.05, (ms) => vi.advanceTimersByTimeAsync(ms));
      e.restore();
      vi.useRealTimers();
      return out as unknown as DiagnosticResult;
    };
    const big = await run(0.1);
    expect(big.status).toBe('warn');
    expect(big.summary).toMatch(/gaps/);
    const tiny = await run(0.003);
    expect(tiny.summary).not.toMatch(/gaps/);
  });

  it('a Bluetooth-sized delay is a warning', async () => {
    const e = fake({ latencySec: 0.3, leak: 0.4 });
    const r = await runInteractive(e, () => runDiagnostic('click-probe'));
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Bluetooth/);
  });

  it('a denied microphone fails with the recorder message and leaves nothing open', async () => {
    const e = fake({ micError: 'NotAllowedError' });
    const r = await runDiagnostic('click-probe');
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/blocked/);
    expect(e.contexts.every((c) => c.state === 'closed')).toBe(true);
  });

  it('leaving the app during the test: a warning that says to keep the screen on', async () => {
    const e = fake({ leak: 0.4 });
    vi.useFakeTimers();
    let out: DiagnosticResult | null = null;
    void runDiagnostic('click-probe').then((r) => (out = r));
    await runFor(e, 0.8, (ms) => vi.advanceTimersByTimeAsync(ms));
    e.hidePage();
    for (let i = 0; i < 60 && !out; i++) await runFor(e, 0.05, (ms) => vi.advanceTimersByTimeAsync(ms));
    expect((out as DiagnosticResult | null)?.status).toBe('warn');
    expect((out as DiagnosticResult | null)?.summary).toMatch(/interrupted/);
  });

  it('abort stops the take early', async () => {
    const e = fake({ leak: 0.4 });
    vi.useFakeTimers();
    const ctl = new AbortController();
    let out: DiagnosticResult | null = null;
    void runDiagnostic('click-probe', { signal: ctl.signal }).then((r) => (out = r));
    await runFor(e, 0.8, (ms) => vi.advanceTimersByTimeAsync(ms));
    ctl.abort();
    for (let i = 0; i < 40 && !out; i++) await runFor(e, 0.05, (ms) => vi.advanceTimersByTimeAsync(ms));
    expect(out).not.toBeNull();
  });
});

describe('mic-level', () => {
  const voiceAt = (amp: number) => (frame: number, n: number, sr: number): Float32Array => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * (frame + i)) / sr));

  /** Sings for the first `sec` seconds of the context clock, then stays quiet (the check asks for that). */
  const singThenQuiet = (sec: number, amp: number) => (frame: number, n: number, sr: number): Float32Array =>
    Float32Array.from({ length: n }, (_, i) => ((frame + i) / sr < sec ? amp * Math.sin((2 * Math.PI * 220 * (frame + i)) / sr) : 0));

  it('a good level: ok, with levels, progress and the round trip result', async () => {
    const e = fake({ voice: singThenQuiet(0.6, 0.1), noiseRms: 0.0005 });
    const seen: number[] = [];
    const r = await runInteractive(e, () => runDiagnostic('mic-level', { seconds: 1.2, onProgress: (p) => p.level !== undefined && seen.push(p.level) }));
    expect(r.status).toBe('ok');
    expect(Number(r.details.loudRmsDbfs)).toBeGreaterThan(-30);
    expect(r.details.clippedPercent).toBe(0);
    expect(r.details.roundTrip).toBe('MediaRecorder is not available');
    expect(seen.length).toBeGreaterThan(5);
    expect(Math.max(...seen)).toBeGreaterThan(0.3);
    expect(r.sensitive).toEqual(['deviceName']);
    expect(r.details.deviceName).toBe('iPhone Microphone');
    expect(e.contexts.every((c) => c.state === 'closed')).toBe(true);
    expect(e.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))).toBe(true);
  });

  it('quiet, clipped and noisy rooms each get their own sentence', async () => {
    let e = fake({ voice: voiceAt(0.0008), noiseRms: 0.0002 });
    let r = await runInteractive(e, () => runDiagnostic('mic-level', { seconds: 1 }));
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Very quiet|Quiet/);
    e.restore();
    e = fake({ voice: voiceAt(1.5), noiseRms: 0.0005 });
    r = await runInteractive(e, () => runDiagnostic('mic-level', { seconds: 1 }));
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/Too loud/);
    e.restore();
    e = fake({ voice: voiceAt(0.1), noiseRms: 0.08 });
    r = await runInteractive(e, () => runDiagnostic('mic-level', { seconds: 1 }));
    expect(r.status).toBe('warn');
    expect(r.summary).toMatch(/noisy/);
  });

  it('with a MediaRecorder it records, decodes and reports what the device wrote', async () => {
    class FakeRecorder {
      state = 'inactive';
      mimeType = 'audio/mp4';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([makeTestWav()]) });
        this.onstop?.();
      }
      static isTypeSupported = (t: string) => t === 'audio/mp4';
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const e = fake({ voice: singThenQuiet(0.6, 0.1) });
    const r = await runInteractive(e, () => runDiagnostic('mic-level', { seconds: 1.2 }));
    expect(r.details['roundTrip.mimeType']).toBe('audio/mp4');
    expect(String(r.details.roundTrip)).toMatch(/decoded 0.25 s/);
  });

  it('a denied microphone is a failed check with the next step', async () => {
    fake({ micError: 'NotFoundError' });
    const r = await runDiagnostic('mic-level', { seconds: 1 });
    expect(r.status).toBe('fail');
    expect(r.summary).toMatch(/No microphone was found/);
  });

  it('abort ends the measurement early without a verdict', async () => {
    const e = fake({ voice: voiceAt(0.1) });
    vi.useFakeTimers();
    const ctl = new AbortController();
    let out: DiagnosticResult | null = null;
    void runDiagnostic('mic-level', { seconds: 10, signal: ctl.signal }).then((r) => (out = r));
    await runFor(e, 0.5, (ms) => vi.advanceTimersByTimeAsync(ms));
    ctl.abort();
    for (let i = 0; i < 40 && !out; i++) await runFor(e, 0.05, (ms) => vi.advanceTimersByTimeAsync(ms));
    expect((out as DiagnosticResult | null)?.status).toBe('info');
    expect((out as DiagnosticResult | null)?.summary).toMatch(/Stopped/);
  });
});

describe('runQuickDiagnostics', () => {
  it('runs the quick checks in order, reports each as it arrives and survives a failing one', async () => {
    fake({ decodes: [] });
    vi.stubGlobal('indexedDB', undefined);
    const seen: string[] = [];
    const out = await runQuickDiagnostics({ onResult: (r) => seen.push(r.id) });
    expect(out.map((r) => r.id)).toEqual([...QUICK_DIAGNOSTICS]);
    expect(seen).toEqual(out.map((r) => r.id));
    expect(out.find((r) => r.id === 'decode')?.status).toBe('fail');
    expect(out.find((r) => r.id === 'indexeddb')?.status).toBe('fail');
    expect(out.find((r) => r.id === 'audio-context')?.status).toBe('ok');
  });

  it('stops when aborted', async () => {
    fake();
    const ctl = new AbortController();
    const seen: string[] = [];
    await runQuickDiagnostics({
      signal: ctl.signal,
      onResult: (r) => {
        seen.push(r.id);
        if (seen.length === 2) ctl.abort();
      },
    });
    expect(seen).toHaveLength(2);
  });
});

describe('formatDiagnostics', () => {
  const results: DiagnosticResult[] = [
    { id: 'route', label: 'Microphones', status: 'warn', summary: 'Bluetooth in use.', details: { microphones: 2, 'microphone.1.name': "Raj's AirPods", missing: null }, sensitive: ['microphone.1.name'] },
    { id: 'storage', label: 'Storage', status: 'ok', summary: 'Persistent.', details: {} },
  ];
  const at = new Date('2026-10-08T12:00:00Z');

  it('lists every check with its status, summary and details, and keeps microphone names out by default', () => {
    const text = formatDiagnostics(results, { at, appVersion: 'build abc1234' });
    expect(text).toContain('Made: 2026-10-08T12:00:00.000Z');
    expect(text).toContain('App: build abc1234');
    expect(text).toContain('Microphones: WARN - Bluetooth in use.');
    expect(text).toContain('    microphones: 2');
    expect(text).toContain('    missing: -');
    expect(text).not.toContain('AirPods');
    expect(text).toContain('Storage: OK - Persistent.');
    expect(text).toMatch(/no audio and no recordings/);
    expect(text).toMatch(/Microphone names are left out/);
  });

  it('includes names only when asked', () => {
    const text = formatDiagnostics(results, { at, includeLabels: true });
    expect(text).toContain("microphone.1.name: Raj's AirPods");
    expect(text).not.toMatch(/Microphone names are left out/);
  });

  it('appends answered checklist items and notes', () => {
    const text = formatDiagnostics(results, { at, checklist: { 'silent-switch': 'pass', 'leave-app': 'fail' }, notes: '  AirPods Pro 2, iOS 18.4  ' });
    expect(text).toContain('Checklist on the device:');
    expect(text).toMatch(/PASS\s+The guide plays with the side switch on silent/);
    expect(text).toMatch(/FAIL\s+Leaving the app during a take/);
    expect(text).not.toMatch(/Adding a Voice Memo/);
    expect(text.endsWith('AirPods Pro 2, iOS 18.4')).toBe(true);
  });

  it('works with no results', () => {
    expect(formatDiagnostics([], { at })).toContain('device report');
  });
});

describe('DEVICE_CHECKLIST', () => {
  it('has unique ids, steps and a stated expectation for every item', () => {
    expect(new Set(DEVICE_CHECKLIST.map((c) => c.id)).size).toBe(DEVICE_CHECKLIST.length);
    for (const c of DEVICE_CHECKLIST) {
      expect(c.title.length).toBeGreaterThan(8);
      expect(c.steps.length).toBeGreaterThan(0);
      expect(c.expect.length).toBeGreaterThan(20);
    }
  });
});
