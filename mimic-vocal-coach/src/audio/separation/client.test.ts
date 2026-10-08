import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../../analysis/abort';
import { checkSeparation, currentEnv, estimateSecondsLeft, isolateVocal, isSeparationAvailable, isSingleFileBuild, probeWasmFeatures, WORKER_GREETING_TIMEOUT_MS, type IsolateProgress, type SeparationEnv } from './client';
import { SeparationError } from './errors';
import type { ModelManifest } from './manifest';
import { MODEL_CACHE_NAME, type ModelCacheDeps } from './modelCache';
import type { SeparatorRunRequest, SeparatorWorkerMessage } from './protocol';

const BASE = 'https://app.test/mimic/';
const MODEL = new Uint8Array(2000).map((_, i) => (i * 7) & 255);
const sha = (b: Uint8Array | ArrayBuffer) => createHash('sha256').update(b instanceof Uint8Array ? b : new Uint8Array(b)).digest('hex');
const manifest: ModelManifest = { name: 'Fake', version: '3', bytes: MODEL.length, sha256: sha(MODEL), licence: 'MIT', source: 'test', inputRate: 44100 };

const FULL_ENV: SeparationEnv = { singleFile: false, hasWorker: true, hasWasm: true, hasSimd: true, hasSharedMemory: true, hasSubtle: true };

/** A site with a manifest and (optionally) the model file, an in-memory Cache Storage, and a hash. No real network. */
function site(opts: { manifest?: boolean; model?: boolean; kept?: boolean } = {}) {
  const { manifest: hasManifest = true, model: hasModel = true, kept = false } = opts;
  const store = new Map<string, Response>();
  if (kept) {
    store.set(`${BASE}models/vocal-isolation.onnx`, new Response(MODEL));
    store.set(`${BASE}models/vocal-isolation.json`, new Response(JSON.stringify(manifest)));
  }
  const calls: string[] = [];
  const cache = {
    match: async (u: RequestInfo | URL) => store.get(String(u))?.clone(),
    put: async (u: RequestInfo | URL, r: Response) => void store.set(String(u), r),
    delete: async (u: RequestInfo | URL) => store.delete(String(u)),
  };
  let cacheExists = kept;
  const deps: ModelCacheDeps = {
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace(BASE, '')}`);
      if (url.endsWith('.json')) return hasManifest ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('', { status: 404 });
      if (!hasModel) return new Response('', { status: 404 });
      return new Response(init?.method === 'HEAD' ? null : MODEL, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    },
    caches: {
      open: async () => ((cacheExists = true), cache as unknown as Cache),
      delete: async () => ((cacheExists = false), store.clear(), true),
      has: async () => cacheExists,
    },
    sha256Hex: async (b) => sha(b),
    resolve: (p) => BASE + p,
    sleep: async () => undefined,
  };
  return { deps, calls, store };
}

describe('checkSeparation: when is the option offered', () => {
  it('is not offered in the single-file build, and asks the network nothing', async () => {
    const s = site();
    const a = await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, singleFile: true } });
    expect(a).toMatchObject({ available: false, reason: 'single-file' });
    expect(s.calls).toEqual([]);
  });

  it('is not offered without workers, WebAssembly or a secure page', async () => {
    const s = site();
    expect((await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, hasWorker: false } })).reason).toBe('no-worker');
    expect((await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, hasWasm: false } })).reason).toBe('no-wasm');
    expect((await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, hasSimd: false } })).reason).toBe('no-simd');
    expect((await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, hasSharedMemory: false } })).reason).toBe('no-shared-memory');
    expect((await checkSeparation({ deps: s.deps, env: { ...FULL_ENV, hasSubtle: false } })).reason).toBe('insecure');
  });

  it('probes what WebAssembly can do: SIMD and the shared 4 GB memory the runtime always creates', () => {
    // This runtime (Node) has both; a browser that refuses either must be told "not offered" before a 20 MB download.
    expect(probeWasmFeatures()).toEqual({ simd: true, sharedMemory: true });
    const refuses = (over: Partial<{ validate: () => boolean; Memory: unknown }>) => ({ validate: WebAssembly.validate.bind(WebAssembly), Memory: WebAssembly.Memory, ...over }) as unknown as typeof WebAssembly;
    expect(probeWasmFeatures(refuses({ validate: () => false }))).toEqual({ simd: false, sharedMemory: true });
    expect(probeWasmFeatures(refuses({ validate: () => { throw new Error('no'); } }))).toMatchObject({ simd: false });
    class NoShared {
      constructor() {
        throw new RangeError('Out of memory (shared memory, maximum 65536 pages)');
      }
    }
    expect(probeWasmFeatures(refuses({ Memory: NoShared }))).toEqual({ simd: true, sharedMemory: false });
    expect(currentEnv()).toMatchObject({ hasWasm: true, hasSimd: true, hasSharedMemory: true });
  });

  it('in the native app the bundled model counts as already on the phone, without asking Cache Storage or sending a HEAD', async () => {
    const s = site();
    const a = await checkSeparation({ deps: { ...s.deps, native: true, caches: undefined }, env: FULL_ENV });
    expect(a).toMatchObject({ available: true, modelKept: true });
    expect(s.calls.some((c) => /HEAD/.test(c))).toBe(false);
  });

  it('is not offered when the site has no manifest', async () => {
    expect(await checkSeparation({ deps: site({ manifest: false }).deps, env: FULL_ENV })).toMatchObject({ available: false, reason: 'no-manifest' });
  });

  it('is not offered when the manifest is there but the model file is not (the model is not committed)', async () => {
    const a = await checkSeparation({ deps: site({ model: false }).deps, env: FULL_ENV });
    expect(a).toMatchObject({ available: false, reason: 'no-model' });
    expect(a.manifest?.name).toBe('Fake');
  });

  it('is offered, with its manifest, when the site carries the model; a HEAD request, not a download', async () => {
    const s = site();
    const a = await checkSeparation({ deps: s.deps, env: FULL_ENV });
    expect(a).toMatchObject({ available: true, reason: null, modelKept: false });
    expect(a.manifest?.version).toBe('3');
    expect(s.calls).toEqual(['GET models/vocal-isolation.json', 'HEAD models/vocal-isolation.onnx']);
  });

  it('knows when the model is already on the device', async () => {
    const a = await checkSeparation({ deps: site({ kept: true }).deps, env: FULL_ENV });
    expect(a).toMatchObject({ available: true, modelKept: true });
  });

  it('treats a kept model of another version as not kept', async () => {
    const s = site({ kept: true });
    s.store.set(`${BASE}models/vocal-isolation.json`, new Response(JSON.stringify({ ...manifest, version: '2' })));
    expect((await checkSeparation({ deps: s.deps, env: FULL_ENV })).modelKept).toBe(false);
  });

  it('isSeparationAvailable never rejects, and is false where the real environment cannot do it (no worker in Node)', async () => {
    expect(await isSeparationAvailable({ env: { singleFile: true } })).toBe(false);
    expect(await isSeparationAvailable({ deps: site().deps, env: FULL_ENV })).toBe(true);
    expect(await isSeparationAvailable({})).toBe(false); // this test process has no Worker
  });

  it('the test build is not the single-file build', () => {
    expect(isSingleFileBuild()).toBe(false);
  });
});

/** A fake worker that answers like separator.worker.ts, driven by the test. */
class FakeWorker {
  onmessage: ((e: MessageEvent<SeparatorWorkerMessage>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  request: SeparatorRunRequest | null = null;
  postMessage = vi.fn((req: SeparatorRunRequest) => {
    this.request = req;
  });
  terminate = vi.fn(() => {
    this.terminated = true;
  });
  say(msg: SeparatorWorkerMessage) {
    this.onmessage?.({ data: msg } as MessageEvent<SeparatorWorkerMessage>);
  }
}
const asWorker = (w: FakeWorker): Worker => w as unknown as Worker;

afterEach(() => vi.useRealTimers());

describe('isolateVocal', () => {
  const samples = () => new Float32Array([0.1, 0.2, 0.3, 0.4]);

  async function start(extra: Partial<Parameters<typeof isolateVocal>[0]> = {}, s = site()) {
    const worker = new FakeWorker();
    const progress: IsolateProgress[] = [];
    const downloads: number[] = [];
    const p = isolateVocal({ samples: samples(), sampleRate: 44100, onProgress: (x) => progress.push(x), onDownload: (d) => downloads.push(d.fraction), ...extra }, { model: s.deps, env: FULL_ENV, createWorker: () => asWorker(worker) });
    // let the manifest check and the model download finish and the run message be posted
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    return { worker, p, progress, downloads, s };
  }

  it('downloads and verifies the model, hands it and a copy of the samples to the worker, and returns the vocal', async () => {
    const input = samples();
    const { worker, p, progress, downloads } = await start({ samples: input, overlap: 0.5 });
    expect(worker.request?.type).toBe('run');
    expect(worker.request?.sampleRate).toBe(44100);
    expect(worker.request?.overlap).toBe(0.5);
    expect(Buffer.from(worker.request?.model ?? new ArrayBuffer(0)).equals(Buffer.from(MODEL))).toBe(true);
    expect(worker.request?.samples).not.toBe(input); // a copy: the caller keeps its samples unless it asked to hand them over
    expect(Array.from(worker.request?.samples ?? [])).toEqual(Array.from(input));
    expect(input.length).toBe(4);
    expect(downloads.at(-1)).toBe(1);

    worker.say({ type: 'alive' });
    worker.say({ type: 'loading' });
    worker.say({ type: 'progress', fraction: 0.01, stage: 'separate', patch: 0, patches: 4 });
    worker.say({ type: 'progress', fraction: 0.5, stage: 'separate', patch: 2, patches: 4 });
    const vocals = new Float32Array([0.05, 0.1, 0.15, 0.2]);
    worker.say({ type: 'result', vocals, sampleRate: 44100, patches: 4, elapsedMs: 1234, loadMs: 10 });
    const out = await p;
    expect(out.vocals).toBe(vocals);
    expect(out.model).toEqual({ name: 'Fake', version: '3' });
    expect(out).toMatchObject({ patches: 4, downloaded: true, modelKept: true });
    expect(worker.terminated).toBe(true);
    // First "starting" (the model is ready, the engine is starting), then the worker's own reports.
    expect(progress.map((x) => x.fraction)).toEqual([0, 0.01, 0.5]);
    expect(progress[0]).toMatchObject({ phase: 'starting', etaSec: null });
    expect(progress[2]).toMatchObject({ patch: 2, patches: 4, phase: 'separating' });
  });

  it('hands over the samples themselves when asked (consume), saving a song-sized copy', async () => {
    const input = samples();
    const { worker, p } = await start({ samples: input, consume: true });
    expect(worker.request?.samples).toBe(input);
    worker.say({ type: 'result', vocals: new Float32Array(4), sampleRate: 44100, patches: 1, elapsedMs: 1, loadMs: 1 });
    await p;
  });

  it('does not download again when the model is already on the device', async () => {
    const s = site({ kept: true });
    const { worker, p, downloads } = await start({}, s);
    worker.say({ type: 'result', vocals: new Float32Array(4), sampleRate: 44100, patches: 1, elapsedMs: 1, loadMs: 1 });
    const out = await p;
    expect(out.downloaded).toBe(false);
    expect(downloads).toEqual([]);
    expect(s.calls.some((c) => c === 'GET models/vocal-isolation.onnx')).toBe(false);
  });

  it('estimates the time left from how long the finished patches took', () => {
    expect(estimateSecondsLeft(10000, 2, 12)).toBe(50);
    expect(estimateSecondsLeft(10000, 12, 12)).toBe(0);
    expect(estimateSecondsLeft(0, 2, 12)).toBeNull();
    expect(estimateSecondsLeft(5000, 0, 12)).toBeNull();
  });

  it('reports the estimated seconds left once the first patch is done, and not before', async () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const { worker, p, progress } = await start();
    worker.say({ type: 'progress', fraction: 0.01, stage: 'separate', patch: 0, patches: 5 });
    now.mockReturnValue(1000 + 4000);
    worker.say({ type: 'progress', fraction: 0.2, stage: 'separate', patch: 1, patches: 5 });
    now.mockReturnValue(1000 + 8000);
    worker.say({ type: 'progress', fraction: 0.4, stage: 'separate', patch: 2, patches: 5 });
    worker.say({ type: 'result', vocals: new Float32Array(4), sampleRate: 44100, patches: 5, elapsedMs: 1, loadMs: 1 });
    await p;
    now.mockRestore();
    expect(progress.map((x) => x.etaSec)).toEqual([null, null, 16, 12]);
  });

  it('cancelling terminates the worker at once and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const { worker, p } = await start({ signal: controller.signal });
    worker.say({ type: 'alive' });
    controller.abort();
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(worker.terminated).toBe(true);
  });

  it('cancelling before it starts never creates a worker', async () => {
    const controller = new AbortController();
    controller.abort();
    const createWorker = vi.fn();
    const err = await isolateVocal({ samples: samples(), sampleRate: 44100, signal: controller.signal }, { model: site().deps, env: FULL_ENV, createWorker }).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('a worker error becomes a SeparationError with the worker\'s words, and the worker is stopped', async () => {
    const { worker, p } = await start();
    worker.say({ type: 'alive' });
    worker.say({ type: 'error', reason: 'run-failed', message: 'Splitting the song failed (out of memory).' });
    const err = (await p.catch((e: unknown) => e)) as SeparationError;
    expect(err).toBeInstanceOf(SeparationError);
    expect(err.reason).toBe('run-failed');
    expect(err.message).toMatch(/out of memory/);
    expect(worker.terminated).toBe(true);
  });

  it('a worker that cannot load its script (blocked, missing file) is an init failure', async () => {
    const { worker, p } = await start();
    worker.onerror?.({ message: 'Failed to fetch module', preventDefault: () => undefined } as unknown as ErrorEvent);
    const err = (await p.catch((e: unknown) => e)) as SeparationError;
    expect(err.reason).toBe('init-failed');
    expect(worker.terminated).toBe(true);
  });

  it('a worker that never says anything is treated as blocked after the greeting timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = new FakeWorker();
    const p = isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: site().deps, env: FULL_ENV, createWorker: () => asWorker(worker) });
    const caught = p.catch((e: unknown) => e);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(WORKER_GREETING_TIMEOUT_MS + 1);
    const err = (await caught) as SeparationError;
    expect(err.reason).toBe('init-failed');
    expect(worker.terminated).toBe(true);
  });

  it('fails clearly, before downloading anything, when the build or browser cannot do it', async () => {
    const s = site();
    const err = (await isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: s.deps, env: { ...FULL_ENV, singleFile: true } }).catch((e: unknown) => e)) as SeparationError;
    expect(err.reason).toBe('unavailable');
    expect(s.calls).toEqual([]);
  });

  it('fails with model-missing when the site has a manifest but no model, or no manifest at all', async () => {
    for (const s of [site({ model: false }), site({ manifest: false })]) {
      const err = (await isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: s.deps, env: FULL_ENV, createWorker: () => asWorker(new FakeWorker()) }).catch((e: unknown) => e)) as SeparationError;
      expect(err.reason).toBe('model-missing');
    }
  });

  it('offline with no model on the phone says so, not "this copy has no model"', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    try {
      const s = site({ manifest: false });
      const err = (await isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: s.deps, env: FULL_ENV, createWorker: () => asWorker(new FakeWorker()) }).catch((e: unknown) => e)) as SeparationError;
      expect(err.reason).toBe('download-failed');
      expect(err.retryable).toBe(true);
      expect(err.message).toMatch(/offline/i);
      expect(err.message).not.toMatch(/does not include/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a download that fails is reported as download-failed and no worker is started', async () => {
    const s = site();
    const base = s.deps.fetch;
    s.deps.fetch = async (url, init) => {
      if (init?.method !== 'HEAD' && url.endsWith('.onnx')) throw new TypeError('offline');
      return base(url, init);
    };
    const createWorker = vi.fn();
    const err = (await isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: s.deps, env: FULL_ENV, createWorker }).catch((e: unknown) => e)) as SeparationError;
    expect(err.reason).toBe('download-failed');
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('a downloaded file that does not match the manifest is refused and never reaches the worker', async () => {
    const s = site();
    const base = s.deps.fetch;
    s.deps.fetch = async (url, init) => (init?.method !== 'HEAD' && url.endsWith('.onnx') ? new Response(new Uint8Array(MODEL.length).fill(9), { status: 200 }) : base(url, init));
    const createWorker = vi.fn();
    const err = (await isolateVocal({ samples: samples(), sampleRate: 44100 }, { model: s.deps, env: FULL_ENV, createWorker }).catch((e: unknown) => e)) as SeparationError;
    expect(err.reason).toBe('hash-mismatch');
    expect(createWorker).not.toHaveBeenCalled();
    expect(s.store.size).toBe(0);
  });

  it('keeps the model under its own cache name, so an app update never deletes it', () => {
    expect(MODEL_CACHE_NAME.startsWith('mimic-precache-')).toBe(false);
  });
});
