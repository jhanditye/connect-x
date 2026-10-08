import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../../analysis/abort';
import { SeparationError } from './errors';
import type { ModelManifest } from './manifest';
import { ENGINE_CACHE_NAME, ensureModel, keptModelInfo, loadManifest, modelFileServed, MODEL_CACHE_NAME, readKeptModel, removeIsolationFiles, removeKeptEngine, removeKeptModel, type ModelCacheDeps } from './modelCache';

// A tiny "model" stands in for the 20 MB file; everything else (fetch, Cache Storage, hashing) is faked, so no network is used.
const BASE = 'https://app.test/mimic/';
const MODEL_URL = `${BASE}models/vocal-isolation.onnx`;
const MANIFEST_URL = `${BASE}models/vocal-isolation.json`;

function bytesOf(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255;
  return b;
}
const sha = (b: Uint8Array | ArrayBuffer): string => createHash('sha256').update(b instanceof Uint8Array ? b : new Uint8Array(b)).digest('hex');

const MODEL = bytesOf(5000);
const manifest: ModelManifest = { name: 'Fake model', version: '1', bytes: MODEL.length, sha256: sha(MODEL), licence: 'MIT', source: 'test', inputRate: 44100 };

function streamOf(data: Uint8Array, chunk = 1000, failAfter?: number): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) {
        controller.error(new TypeError('network dropped'));
        return;
      }
      if (at >= data.length) return controller.close();
      controller.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

class FakeCache {
  readonly map = new Map<string, Response>();
  failPut = false;
  async match(url: RequestInfo | URL): Promise<Response | undefined> {
    return this.map.get(String(url))?.clone();
  }
  async put(url: RequestInfo | URL, res: Response): Promise<void> {
    if (this.failPut) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(String(url), res);
  }
  async delete(url: RequestInfo | URL): Promise<boolean> {
    return this.map.delete(String(url));
  }
}

interface Rig {
  deps: ModelCacheDeps;
  cache: FakeCache;
  stores: Map<string, FakeCache>;
  fetch: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

type Handler = (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>;

function rig(handler: Handler, opts: { noCaches?: boolean } = {}): Rig {
  const cache = new FakeCache();
  const stores = new Map<string, FakeCache>([[MODEL_CACHE_NAME, cache]]);
  const calls = new Map<string, number>();
  const sleeps: number[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const n = (calls.get(url) ?? 0) + 1;
    calls.set(url, n);
    return handler(url, init, n);
  });
  const deps: ModelCacheDeps = {
    fetch: fetchFn,
    caches: opts.noCaches
      ? undefined
      : {
          open: async (name: string) => (stores.get(name) ?? stores.set(name, new FakeCache()).get(name)) as unknown as Cache,
          delete: async (name: string) => stores.delete(name),
          has: async (name: string) => stores.has(name),
        },
    sha256Hex: async (b) => sha(b),
    resolve: (path) => BASE + path,
    sleep: async (ms) => void sleeps.push(ms),
  };
  return { deps, cache, stores, fetch: fetchFn, sleeps };
}

const asBody = (u: Uint8Array): BodyInit => u as unknown as BodyInit;
const ok = (data: Uint8Array, headers: Record<string, string> = { 'content-type': 'application/octet-stream' }) => new Response(streamOf(data), { status: 200, headers });

describe('ensureModel: the download', () => {
  it('downloads with progress, verifies size and SHA-256, keeps the model, and uses the kept copy next time', async () => {
    const r = rig((url) => (url === MODEL_URL ? ok(MODEL) : new Response('', { status: 404 })));
    const seen: number[] = [];
    const first = await ensureModel(r.deps, manifest, { onProgress: (p) => seen.push(p.fraction) });
    expect(first.downloaded).toBe(true);
    expect(first.cached).toBe(true);
    expect(Buffer.from(first.bytes).equals(Buffer.from(MODEL))).toBe(true);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // never goes backwards
    expect(r.cache.map.has(MODEL_URL)).toBe(true);
    expect(r.cache.map.has(MANIFEST_URL)).toBe(true); // kept so the feature still works offline

    const second = await ensureModel(r.deps, manifest);
    expect(second.downloaded).toBe(false);
    expect(Buffer.from(second.bytes).equals(Buffer.from(MODEL))).toBe(true);
    expect(r.fetch).toHaveBeenCalledTimes(1);
  });

  it('says plainly when the site does not carry the model (404, or a page that answers every address with HTML) and does not retry', async () => {
    for (const res of [() => new Response('nope', { status: 404 }), () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
      const r = rig(res);
      const err = await ensureModel(r.deps, manifest).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SeparationError);
      expect((err as SeparationError).reason).toBe('model-missing');
      expect(r.fetch).toHaveBeenCalledTimes(1);
      expect(r.cache.map.size).toBe(0);
    }
  });

  it('retries a failed network request and succeeds on the next attempt', async () => {
    const r = rig((_url, _init, call) => {
      if (call === 1) throw new TypeError('offline');
      return ok(MODEL);
    });
    const out = await ensureModel(r.deps, manifest);
    expect(out.downloaded).toBe(true);
    expect(r.fetch).toHaveBeenCalledTimes(2);
    expect(r.sleeps.length).toBe(1);
  });

  it('gives up with a retryable download-failed error after the attempts, and keeps nothing', async () => {
    const r = rig(() => {
      throw new TypeError('offline');
    });
    const err = (await ensureModel(r.deps, manifest, { attempts: 3 }).catch((e: unknown) => e)) as SeparationError;
    expect(err.reason).toBe('download-failed');
    expect(err.retryable).toBe(true);
    expect(r.fetch).toHaveBeenCalledTimes(3);
    expect(r.cache.map.size).toBe(0);
  });

  it('treats a download that stops short, or breaks half way, as failed and never keeps the partial file', async () => {
    const short = rig(() => ok(MODEL.slice(0, 3000)));
    const e1 = (await ensureModel(short.deps, manifest, { attempts: 2 }).catch((e: unknown) => e)) as SeparationError;
    expect(e1.reason).toBe('download-failed');
    expect(short.cache.map.size).toBe(0);

    const broken = rig(() => new Response(streamOf(MODEL, 1000, 2000), { status: 200 }));
    const e2 = (await ensureModel(broken.deps, manifest, { attempts: 2 }).catch((e: unknown) => e)) as SeparationError;
    expect(e2.reason).toBe('download-failed');
    expect(broken.cache.map.size).toBe(0);

    const long = rig(() => ok(bytesOf(MODEL.length + 700)));
    const e3 = (await ensureModel(long.deps, manifest, { attempts: 1 }).catch((e: unknown) => e)) as SeparationError;
    expect(e3.reason).toBe('download-failed');
  });

  it('refuses a file whose SHA-256 does not match the manifest, tries again once more, and throws it away', async () => {
    const wrong = bytesOf(MODEL.length, 9); // the right size, the wrong content
    const r = rig(() => ok(wrong));
    const err = (await ensureModel(r.deps, manifest, { attempts: 2 }).catch((e: unknown) => e)) as SeparationError;
    expect(err).toBeInstanceOf(SeparationError);
    expect(err.reason).toBe('hash-mismatch');
    expect(r.fetch).toHaveBeenCalledTimes(2);
    expect(r.cache.map.size).toBe(0);
  });

  it('recovers when the first copy was damaged in transit but the second is right', async () => {
    const r = rig((_u, _i, call) => ok(call === 1 ? bytesOf(MODEL.length, 9) : MODEL));
    const out = await ensureModel(r.deps, manifest);
    expect(out.downloaded).toBe(true);
    expect(Buffer.from(out.bytes).equals(Buffer.from(MODEL))).toBe(true);
  });

  it('deletes a kept copy that no longer matches the manifest (a newer version, a damaged write) and fetches a fresh one', async () => {
    const r = rig(() => ok(MODEL));
    await r.cache.put(MODEL_URL, new Response(asBody(bytesOf(MODEL.length, 7))));
    expect(await readKeptModel(r.deps, manifest)).toBeNull();
    expect(r.cache.map.has(MODEL_URL)).toBe(false);

    await r.cache.put(MODEL_URL, new Response(asBody(bytesOf(100))));
    const out = await ensureModel(r.deps, manifest);
    expect(out.downloaded).toBe(true);
    expect(r.cache.map.has(MODEL_URL)).toBe(true);
  });

  it('cancels mid-download with an AbortError and keeps nothing', async () => {
    const controller = new AbortController();
    const r = rig((_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(MODEL.slice(0, 1000));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const p = ensureModel(r.deps, manifest, { signal: controller.signal, onProgress: (x) => x.loadedBytes >= 1000 && controller.abort() });
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(r.cache.map.size).toBe(0);
  });

  it('does not start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = rig(() => ok(MODEL));
    expect(isAbortError(await ensureModel(r.deps, manifest, { signal: controller.signal }).catch((e: unknown) => e))).toBe(true);
    expect(r.fetch).not.toHaveBeenCalled();
  });

  it('still returns the model when the browser will not keep it, and says so', async () => {
    const r = rig(() => ok(MODEL));
    r.cache.failPut = true;
    const out = await ensureModel(r.deps, manifest);
    expect(out.downloaded).toBe(true);
    expect(out.cached).toBe(false);
    expect(r.cache.map.size).toBe(0);
  });

  it('works without Cache Storage at all (nothing is kept)', async () => {
    const r = rig(() => ok(MODEL), { noCaches: true });
    const out = await ensureModel(r.deps, manifest);
    expect(out).toMatchObject({ downloaded: true, cached: false });
  });

  it('also reads a body that cannot be streamed', async () => {
    const r = rig(() => {
      const res = new Response(asBody(MODEL), { status: 200 });
      Object.defineProperty(res, 'body', { value: null });
      return res;
    });
    const out = await ensureModel(r.deps, manifest);
    expect(out.downloaded).toBe(true);
  });
});

describe('the manifest and the kept copy', () => {
  it('loadManifest: absent, not JSON, or invalid means the model is not offered', async () => {
    for (const res of [
      () => new Response('', { status: 404 }),
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response('not json', { status: 200 }),
      () => new Response(JSON.stringify({ ...manifest, sha256: 'bad' }), { status: 200 }),
    ]) {
      expect((await loadManifest(rig(res).deps)).manifest).toBeNull();
    }
  });

  it('loadManifest: reads the manifest from the site', async () => {
    const r = rig(() => new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await loadManifest(r.deps)).toEqual({ manifest, fromCache: false });
  });

  it('loadManifest: offline, uses the copy kept with the model, but only while the model is still on the device', async () => {
    const r = rig(() => {
      throw new TypeError('offline');
    });
    expect((await loadManifest(r.deps)).manifest).toBeNull();
    await r.cache.put(MANIFEST_URL, new Response(JSON.stringify(manifest)));
    expect((await loadManifest(r.deps)).manifest).toBeNull(); // manifest alone is not enough
    await r.cache.put(MODEL_URL, new Response(asBody(MODEL)));
    expect(await loadManifest(r.deps)).toEqual({ manifest, fromCache: true });
  });

  it('loadManifest: a cancel is an AbortError, not "absent"', async () => {
    const r = rig(() => {
      throw new DOMException('x', 'AbortError');
    });
    expect(isAbortError(await loadManifest(r.deps).catch((e: unknown) => e))).toBe(true);
  });

  it('modelFileServed: a HEAD request, true only for a real file (not a 404, not an HTML fallback page)', async () => {
    const seen: (string | undefined)[] = [];
    const good = rig((_u, init) => (seen.push(init?.method), new Response('', { status: 200, headers: { 'content-type': 'application/octet-stream' } })));
    expect(await modelFileServed(good.deps)).toBe(true);
    expect(seen).toEqual(['HEAD']);
    expect(await modelFileServed(rig(() => new Response('', { status: 404 })).deps)).toBe(false);
    expect(await modelFileServed(rig(() => new Response('', { status: 200, headers: { 'content-type': 'text/html' } })).deps)).toBe(false);
    expect(
      await modelFileServed(
        rig(() => {
          throw new TypeError('offline');
        }).deps,
      ),
    ).toBe(false);
  });

  it('keptModelInfo and removeKeptModel: Settings can show what is kept and remove it', async () => {
    const r = rig(() => ok(MODEL));
    expect(await keptModelInfo(r.deps)).toBeNull();
    await ensureModel(r.deps, manifest);
    expect(await keptModelInfo(r.deps)).toEqual({ name: 'Fake model', version: '1', bytes: MODEL.length });
    expect(await removeKeptModel(r.deps)).toBe(true);
    expect(await keptModelInfo(r.deps)).toBeNull();
    expect(r.stores.has(MODEL_CACHE_NAME)).toBe(false);
    expect(await removeKeptModel(rig(() => ok(MODEL), { noCaches: true }).deps)).toBe(false);
  });
  it('removeIsolationFiles removes the model and the service worker\'s engine files, so "Delete everything" really does', async () => {
    const r = rig(() => ok(MODEL));
    await ensureModel(r.deps, manifest);
    await r.deps.caches?.open(ENGINE_CACHE_NAME); // the service worker makes this cache the first time the engine is used
    expect(r.stores.has(ENGINE_CACHE_NAME)).toBe(true);
    expect(await removeIsolationFiles(r.deps)).toBe(true);
    expect(r.stores.has(MODEL_CACHE_NAME)).toBe(false);
    expect(r.stores.has(ENGINE_CACHE_NAME)).toBe(false);
    expect(await removeIsolationFiles(r.deps)).toBe(false); // nothing left
    expect(await removeKeptEngine(rig(() => ok(MODEL), { noCaches: true }).deps)).toBe(false);
  });

  it('the engine cache name is the one the service worker writes to', () => {
    const sw = readFileSync(new URL('../../../scripts/sw.template.js', import.meta.url), 'utf8');
    expect(sw).toContain(`const OPT_IN_CACHE = '${ENGINE_CACHE_NAME}';`);
  });
});
