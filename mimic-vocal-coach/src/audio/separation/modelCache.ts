// The vocal-isolation model file: fetched once from this site (never from anywhere else), checked against the manifest's size and
// SHA-256, and kept in Cache Storage under its own cache name. It is deliberately NOT in the app's offline precache (which stays
// small and is replaced on every update): the service worker leaves models/ alone (scripts/sw.template.js) and this module owns
// the copy. A partial or wrong download is never kept; a kept copy that no longer matches the manifest is deleted and fetched again.
//
// Everything outside the page (fetch, Cache Storage, hashing, waiting) is injected, so the tests run with fakes and no network.

import { abortError, isAbortError } from '../../analysis/abort';
import { SeparationError } from './errors';
import { MODEL_FILE_PATH, MODEL_MANIFEST_PATH, parseManifest, type ModelManifest } from './manifest';

/** Not prefixed `mimic-precache-`, so the service worker's clean-up on update leaves it alone. */
export const MODEL_CACHE_NAME = 'mimic-vocal-model-v1';

/** The service worker's cache for the runtime's .wasm, loader and worker (OPT_IN_CACHE in scripts/sw.template.js; a test keeps the two equal). */
export const ENGINE_CACHE_NAME = 'mimic-optin-v1';

/** Attempts at a download (the first plus retries) before giving up. */
export const DOWNLOAD_ATTEMPTS = 3;

export interface ModelCacheDeps {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Undefined when the browser has no Cache Storage (plain-HTTP page, some private modes). */
  caches: Pick<CacheStorage, 'open' | 'delete' | 'has'> | undefined;
  sha256Hex(bytes: ArrayBuffer): Promise<string>;
  /** An app-relative path made absolute against the page. */
  resolve(path: string): string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * The page is the native iPhone app (Capacitor): the model is part of the app bundle, so there is nothing to download, keep or remove.
   * Cache Storage cannot hold a capacitor:// URL, and a HEAD would make the app read the whole 20 MB file just to check it exists.
   */
  native?: boolean;
}

/** True inside the Capacitor app (the iPhone wrapper in ios-native), where the page is served from the app bundle. */
export function isNativeApp(): boolean {
  const g = globalThis as { Capacitor?: { isNativePlatform?: () => boolean }; location?: { protocol?: string } };
  try {
    if (typeof g.Capacitor?.isNativePlatform === 'function' && g.Capacitor.isNativePlatform()) return true;
  } catch {
    // fall through to the protocol check
  }
  return g.location?.protocol === 'capacitor:' || g.location?.protocol === 'ionic:';
}

export interface DownloadProgress {
  loadedBytes: number;
  totalBytes: number;
  /** 0..1 */
  fraction: number;
}

export interface EnsuredModel {
  /** The verified model file. The caller may hand its buffer to a worker. */
  bytes: ArrayBuffer;
  /** True when it came over the network just now, false when the kept copy was used. */
  downloaded: boolean;
  /** False when the browser would not keep it (it is fetched again next time). */
  cached: boolean;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function defaultModelDeps(): ModelCacheDeps {
  const native = isNativeApp();
  return {
    native,
    fetch: (url, init) => fetch(url, init),
    caches: !native && typeof caches !== 'undefined' ? caches : undefined,
    sha256Hex: async (bytes) => {
      const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
      if (!subtle) throw new SeparationError('unavailable', 'This page cannot check the downloaded model (it needs a secure https address). Open the app from its https address or add it to the Home Screen.');
      return toHex(await subtle.digest('SHA-256', bytes));
    },
    resolve: (path) => new URL(path, typeof document !== 'undefined' ? document.baseURI : (globalThis as { location?: { href: string } }).location?.href).href,
    sleep: realSleep,
  };
}

async function openCache(deps: ModelCacheDeps, create = true): Promise<Cache | null> {
  if (!deps.caches) return null;
  try {
    // Looking must not create an empty cache on every visit; only keeping a model does.
    if (!create && !(await deps.caches.has(MODEL_CACHE_NAME))) return null;
    return (await deps.caches.open(MODEL_CACHE_NAME)) as Cache;
  } catch {
    return null; // private window or blocked site data: the model is used without being kept
  }
}

function isHtml(res: Response): boolean {
  return /text\/html/i.test(res.headers.get('content-type') ?? '');
}

// ---------------------------------------------------------------------------------------------
// The manifest

export interface ManifestLookup {
  manifest: ModelManifest | null;
  /** True when the network could not be reached and the copy kept with the model was used. */
  fromCache: boolean;
}

/** The kept copy of the manifest (stored with the model, so the feature still works offline once the model is on the phone). */
async function readCachedManifest(deps: ModelCacheDeps): Promise<ModelManifest | null> {
  try {
    const cache = await openCache(deps, false);
    const hit = await cache?.match(deps.resolve(MODEL_MANIFEST_PATH));
    return hit ? parseManifest(await hit.json()) : null;
  } catch {
    return null;
  }
}

/**
 * Asks this site for the manifest. A missing file (or one that is not valid) means the model is not offered: null. When the site
 * cannot be reached, the copy kept with the model is used, but only if the model itself is still on the device.
 */
export async function loadManifest(deps: ModelCacheDeps, signal?: AbortSignal): Promise<ManifestLookup> {
  const url = deps.resolve(MODEL_MANIFEST_PATH);
  let res: Response;
  try {
    res = await deps.fetch(url, { cache: 'no-cache', signal });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
    const kept = await readCachedManifest(deps);
    if (kept && (await hasKeptModel(deps))) return { manifest: kept, fromCache: true };
    return { manifest: null, fromCache: false };
  }
  if (!res.ok || isHtml(res)) return { manifest: null, fromCache: false };
  try {
    return { manifest: parseManifest(await res.json()), fromCache: false };
  } catch {
    return { manifest: null, fromCache: false };
  }
}

/** Whether the site really serves the model file (the manifest alone is committed; the model is not). A HEAD request, no download. */
export async function modelFileServed(deps: ModelCacheDeps, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await deps.fetch(deps.resolve(MODEL_FILE_PATH), { method: 'HEAD', cache: 'no-cache', signal });
    return res.ok && !isHtml(res);
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// The kept copy

async function hasKeptModel(deps: ModelCacheDeps): Promise<boolean> {
  try {
    const cache = await openCache(deps, false);
    return !!(await cache?.match(deps.resolve(MODEL_FILE_PATH)));
  } catch {
    return false;
  }
}

/** What is kept on the device: the model's name, version and size (the manifest stored with it), or null. */
export async function keptModelInfo(deps: ModelCacheDeps): Promise<{ name: string; version: string; bytes: number } | null> {
  if (!(await hasKeptModel(deps))) return null;
  const m = await readCachedManifest(deps);
  return m ? { name: m.name, version: m.version, bytes: m.bytes } : null;
}

/** Deletes the kept model and manifest. Returns whether a cache was removed. */
export async function removeKeptModel(deps: ModelCacheDeps): Promise<boolean> {
  if (!deps.caches) return false;
  try {
    return await deps.caches.delete(MODEL_CACHE_NAME);
  } catch {
    return false;
  }
}

/** Deletes the engine files (the WebAssembly runtime and its loader) the service worker kept. Returns whether a cache was removed. */
export async function removeKeptEngine(deps: ModelCacheDeps): Promise<boolean> {
  if (!deps.caches) return false;
  try {
    return await deps.caches.delete(ENGINE_CACHE_NAME);
  } catch {
    return false;
  }
}

/** Everything vocal isolation keeps on the device, the model and the engine. Returns whether anything was removed. */
export async function removeIsolationFiles(deps: ModelCacheDeps): Promise<boolean> {
  const model = await removeKeptModel(deps);
  const engine = await removeKeptEngine(deps);
  return model || engine;
}

/** The kept model, checked against the manifest. A copy that does not match (an older version, a damaged write) is deleted. */
export async function readKeptModel(deps: ModelCacheDeps, manifest: ModelManifest): Promise<ArrayBuffer | null> {
  const cache = await openCache(deps, false);
  if (!cache) return null;
  const url = deps.resolve(MODEL_FILE_PATH);
  let hit: Response | undefined;
  try {
    hit = await cache.match(url);
  } catch {
    return null;
  }
  if (!hit) return null;
  try {
    const buf = await hit.arrayBuffer();
    if (buf.byteLength === manifest.bytes && (await deps.sha256Hex(buf)) === manifest.sha256) return buf;
  } catch (err) {
    if (err instanceof SeparationError) throw err;
  }
  await cache.delete(url).catch(() => false);
  return null;
}

// ---------------------------------------------------------------------------------------------
// The download

async function downloadOnce(deps: ModelCacheDeps, manifest: ModelManifest, signal: AbortSignal | undefined, onProgress: ((p: DownloadProgress) => void) | undefined): Promise<ArrayBuffer> {
  const total = manifest.bytes;
  const report = (loaded: number) => onProgress?.({ loadedBytes: loaded, totalBytes: total, fraction: Math.min(1, loaded / total) });
  let res: Response;
  try {
    res = await deps.fetch(deps.resolve(MODEL_FILE_PATH), { cache: 'no-store', signal });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
    throw new SeparationError('download-failed', 'The vocal model could not be downloaded. Check your connection and try again.', true);
  }
  if (res.status === 404 || isHtml(res)) {
    throw new SeparationError('model-missing', 'This copy of Mimic does not include the vocal-isolation model, so a song cannot be split here. Add the vocal-only version of the song instead.');
  }
  if (!res.ok) throw new SeparationError('download-failed', `The vocal model could not be downloaded (the site answered ${res.status}). Try again in a moment.`, true);

  const out = new Uint8Array(total);
  let loaded = 0;
  const wrongSize = () => new SeparationError('download-failed', 'The vocal model download stopped short or came back the wrong size. Nothing was kept. Try again.', true);
  report(0);
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.byteLength > total) {
          await reader.cancel().catch(() => undefined);
          throw wrongSize();
        }
        out.set(value, loaded);
        loaded += value.byteLength;
        report(loaded);
      }
    } else {
      const all = new Uint8Array(await res.arrayBuffer());
      if (all.byteLength !== total) throw wrongSize();
      out.set(all, 0);
      loaded = total;
      report(loaded);
    }
  } catch (err) {
    if (err instanceof SeparationError) throw err;
    if (isAbortError(err) || signal?.aborted) throw isAbortError(err) ? err : abortError();
    throw new SeparationError('download-failed', 'The vocal model download was interrupted. Nothing was kept. Check your connection and try again.', true);
  }
  if (loaded !== total) throw wrongSize();
  return out.buffer;
}

async function keep(deps: ModelCacheDeps, manifest: ModelManifest, bytes: ArrayBuffer): Promise<boolean> {
  const cache = await openCache(deps);
  if (!cache) return false;
  const modelUrl = deps.resolve(MODEL_FILE_PATH);
  try {
    await cache.put(modelUrl, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(manifest.bytes) } }));
    await cache.put(deps.resolve(MODEL_MANIFEST_PATH), new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/json' } }));
    return true;
  } catch {
    // Storage full or blocked: take back whatever half-landed.
    await cache.delete(modelUrl).catch(() => false);
    return false;
  }
}

export interface EnsureOptions {
  signal?: AbortSignal;
  onProgress?(p: DownloadProgress): void;
  /** Attempts at the download (default DOWNLOAD_ATTEMPTS). */
  attempts?: number;
}

/**
 * The verified model bytes: the kept copy when it matches the manifest, else a fresh download (progress reported), retried when
 * the transfer fails or the file does not match, checked against the manifest's size and SHA-256, and then kept. A file that does
 * not match is never kept and never used. Rejects with a SeparationError (`model-missing`, `download-failed`, `hash-mismatch`)
 * or an AbortError.
 */
export async function ensureModel(deps: ModelCacheDeps, manifest: ModelManifest, options: EnsureOptions = {}): Promise<EnsuredModel> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const kept = await readKeptModel(deps, manifest);
  if (kept) return { bytes: kept, downloaded: false, cached: true };

  const attempts = Math.max(1, options.attempts ?? DOWNLOAD_ATTEMPTS);
  let last: SeparationError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await deps.sleep(600 * (attempt - 1), signal);
    try {
      const bytes = await downloadOnce(deps, manifest, signal, options.onProgress);
      if (signal?.aborted) throw abortError();
      const digest = await deps.sha256Hex(bytes);
      if (digest !== manifest.sha256) {
        last = new SeparationError('hash-mismatch', 'The downloaded vocal model does not match what this site published, so it was thrown away and not used. Try again; if it keeps happening, the copy on the site is damaged.', true);
        continue;
      }
      const cached = await keep(deps, manifest, bytes);
      return { bytes, downloaded: true, cached };
    } catch (err) {
      if (!(err instanceof SeparationError) || !err.retryable) throw err;
      last = err;
    }
  }
  throw last ?? new SeparationError('download-failed', 'The vocal model could not be downloaded.', true);
}
