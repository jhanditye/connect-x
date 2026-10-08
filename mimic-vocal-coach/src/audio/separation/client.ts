// Vocal isolation from the page: is it offered here, and turn a song's samples into an isolated vocal.
//
//   checkSeparation()   the feature is offered only when this build can run it, the browser has what it needs and the site carries
//                       a model manifest (and the model file it describes). Anything missing means "not offered", never an error.
//   isolateVocal()      get the verified model (one download, then kept in Cache Storage), start the module worker, run the signal
//                       pipeline in it, report progress with an estimate of the time left, and give back the mono vocal. Cancelling
//                       (an AbortSignal) terminates the worker at once.
//
// The model and the runtime are fetched from this site only. The worker is created through a dynamic import so the single-file
// build, which has no room for a worker file or the runtime's .wasm, never links it and reports "unavailable" instead of crashing.

import { abortError } from '../../analysis/abort';
import { SeparationError } from './errors';
import { type ModelManifest } from './manifest';
import { defaultModelDeps, ensureModel, keptModelInfo, loadManifest, modelFileServed, type DownloadProgress, type ModelCacheDeps } from './modelCache';
import type { SeparatorRunRequest, SeparatorWorkerMessage } from './protocol';

/** Set by vite.config.ts (true in `vite build --mode single`); undefined in tests, which pass `env` instead. */
declare const __MIMIC_SINGLE_FILE__: boolean | undefined;

export function isSingleFileBuild(): boolean {
  return typeof __MIMIC_SINGLE_FILE__ !== 'undefined' && __MIMIC_SINGLE_FILE__ === true;
}

/** How long a worker may stay silent after it is created before it is treated as blocked (it greets as soon as its script runs). */
export const WORKER_GREETING_TIMEOUT_MS = 10_000;

export type UnavailableReason = 'single-file' | 'no-worker' | 'no-wasm' | 'no-simd' | 'no-shared-memory' | 'insecure' | 'no-manifest' | 'no-model';

export interface SeparationAvailability {
  available: boolean;
  reason: UnavailableReason | null;
  manifest: ModelManifest | null;
  /** The model is already on the device, so using the feature downloads nothing. */
  modelKept: boolean;
}

/** What the page can do. Real values by default; tests pass their own. */
export interface SeparationEnv {
  singleFile: boolean;
  hasWorker: boolean;
  hasWasm: boolean;
  /** WebAssembly SIMD, which the engine's runtime is built on. */
  hasSimd: boolean;
  /** A shared WebAssembly.Memory with a 4 GB ceiling, which the runtime always creates (even for one thread). */
  hasSharedMemory: boolean;
  /** crypto.subtle (https pages only): needed to check the download. */
  hasSubtle: boolean;
}

// The smallest module that uses a SIMD instruction (the one wasm-feature-detect uses): validates only where WebAssembly SIMD exists.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

let wasmFeatures: { simd: boolean; sharedMemory: boolean } | undefined;

/**
 * What this browser's WebAssembly can do, tested once. The runtime (onnxruntime-web, single thread) needs SIMD and always creates a shared
 * memory with a 4 GB maximum; a browser that refuses either would only fail after the 20 MB model had been downloaded, so ask first.
 */
export function probeWasmFeatures(wa: typeof WebAssembly = WebAssembly): { simd: boolean; sharedMemory: boolean } {
  const isDefault = wa === WebAssembly;
  if (isDefault && wasmFeatures) return wasmFeatures;
  let simd = false;
  let sharedMemory = false;
  try {
    simd = wa.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  try {
    // Only the descriptor matters (initial 1 page, not the runtime's 256): the reservation is what some browsers refuse.
    sharedMemory = new wa.Memory({ initial: 1, maximum: 65536, shared: true }) instanceof wa.Memory;
  } catch {
    sharedMemory = false;
  }
  const result = { simd, sharedMemory };
  if (isDefault) wasmFeatures = result;
  return result;
}

export function currentEnv(): SeparationEnv {
  const g = globalThis as { Worker?: unknown; WebAssembly?: unknown; crypto?: { subtle?: unknown } };
  const hasWasm = typeof g.WebAssembly === 'object';
  const features = hasWasm ? probeWasmFeatures() : { simd: false, sharedMemory: false };
  return {
    singleFile: isSingleFileBuild(),
    hasWorker: typeof g.Worker !== 'undefined',
    hasWasm,
    hasSimd: features.simd,
    hasSharedMemory: features.sharedMemory,
    hasSubtle: !!g.crypto?.subtle,
  };
}

function unavailable(reason: UnavailableReason, manifest: ModelManifest | null = null): SeparationAvailability {
  return { available: false, reason, manifest, modelKept: false };
}

export interface CheckOptions {
  deps?: ModelCacheDeps;
  env?: Partial<SeparationEnv>;
  signal?: AbortSignal;
}

export async function checkSeparation(options: CheckOptions = {}): Promise<SeparationAvailability> {
  const env = { ...currentEnv(), ...options.env };
  if (env.singleFile) return unavailable('single-file');
  if (!env.hasWorker) return unavailable('no-worker');
  if (!env.hasWasm) return unavailable('no-wasm');
  if (!env.hasSimd) return unavailable('no-simd');
  if (!env.hasSharedMemory) return unavailable('no-shared-memory');
  if (!env.hasSubtle) return unavailable('insecure');
  const deps = options.deps ?? defaultModelDeps();
  const { manifest, fromCache } = await loadManifest(deps, options.signal);
  if (!manifest) return unavailable('no-manifest');
  // In the native app the model is a file of the app itself: always on the phone, nothing to check, keep or download.
  if (deps.native) return { available: true, reason: null, manifest, modelKept: true };
  const kept = await keptModelInfo(deps);
  const modelKept = !!kept && kept.version === manifest.version && kept.bytes === manifest.bytes && kept.name === manifest.name;
  if (modelKept || fromCache) return { available: true, reason: null, manifest, modelKept };
  if (!(await modelFileServed(deps, options.signal))) return unavailable('no-model', manifest);
  return { available: true, reason: null, manifest, modelKept: false };
}

/** Whether the "isolate the vocal" option should be offered at all. Never rejects. */
export async function isSeparationAvailable(options: CheckOptions = {}): Promise<boolean> {
  try {
    return (await checkSeparation(options)).available;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Running it

export type IsolatePhase = 'starting' | 'separating' | 'finishing';

export interface IsolateProgress {
  phase: IsolatePhase;
  /** 0..1 over the whole separation. */
  fraction: number;
  patch: number;
  patches: number;
  /** Seconds left, from the time the patches finished so far took. Null until the first patch is done. */
  etaSec: number | null;
}

export interface IsolateInput {
  samples: Float32Array;
  sampleRate: number;
  /**
   * Hand the samples' memory to the worker instead of copying it (the caller must not read `samples` afterwards, and gets it
   * back empty). Saves a song-sized copy; leave it off when the samples are still needed if this fails or is cancelled.
   */
  consume?: boolean;
  signal?: AbortSignal;
  /** Called while the model downloads (only when it is not on the device yet). */
  onDownload?(p: DownloadProgress): void;
  onProgress?(p: IsolateProgress): void;
  /** 0 (default) cuts patches as Spleeter does; 0.5 cross-fades half-patch overlaps for twice the model runs. */
  overlap?: 0 | 0.5;
}

export interface IsolateResult {
  /** Mono isolated vocal, at `sampleRate`, as long as the input. */
  vocals: Float32Array;
  sampleRate: number;
  model: { name: string; version: string };
  patches: number;
  elapsedMs: number;
  /** The model came over the network for this run. */
  downloaded: boolean;
  /** The browser kept the model (false: it will be downloaded again next time). */
  modelKept: boolean;
}

export interface IsolateDeps {
  model?: ModelCacheDeps;
  env?: Partial<SeparationEnv>;
  /** Test seam: makes the worker. Default loads workerFactory.ts. */
  createWorker?: () => Worker | Promise<Worker>;
}

async function defaultCreateWorker(): Promise<Worker> {
  const { createSeparatorWorker } = await import('./workerFactory');
  return createSeparatorWorker();
}

/** Seconds left from how long the finished patches took. */
export function estimateSecondsLeft(elapsedMs: number, patchesDone: number, patches: number): number | null {
  if (!(patchesDone >= 1) || !(patches > 0) || !(elapsedMs > 0)) return null;
  const left = Math.max(0, patches - patchesDone);
  return Math.round(((elapsedMs / patchesDone) * left) / 1000);
}

function runInWorker(
  worker: Worker,
  model: ArrayBuffer,
  input: IsolateInput,
): Promise<{ vocals: Float32Array; sampleRate: number; patches: number; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const { signal } = input;
    let settled = false;
    let greeted = false;
    let patchesStartedAt: number | null = null;
    const greeting = setTimeout(() => {
      if (!greeted) fail(new SeparationError('init-failed', 'The vocal-isolation engine did not start. This browser may be blocking it. Reload the app and try again.', true));
    }, WORKER_GREETING_TIMEOUT_MS);
    const end = () => {
      settled = true;
      clearTimeout(greeting);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const fail = (err: Error) => {
      if (settled) return;
      end();
      reject(err);
    };
    const onAbort = () => fail(abortError('Vocal isolation was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<SeparatorWorkerMessage>) => {
      if (settled) return;
      const msg = event.data;
      greeted = true;
      if (msg.type === 'progress') {
        const now = performance.now();
        if (msg.stage === 'separate' && msg.patch === 0 && patchesStartedAt === null) patchesStartedAt = now;
        const phase: IsolatePhase = msg.stage === 'finish' || msg.stage === 'done' ? 'finishing' : msg.patch > 0 || msg.stage === 'separate' ? 'separating' : 'starting';
        input.onProgress?.({
          phase,
          fraction: Math.max(0, Math.min(1, msg.fraction)),
          patch: msg.patch,
          patches: msg.patches,
          etaSec: patchesStartedAt === null ? null : estimateSecondsLeft(now - patchesStartedAt, msg.patch, msg.patches),
        });
      } else if (msg.type === 'result') {
        end();
        resolve({ vocals: msg.vocals, sampleRate: msg.sampleRate, patches: msg.patches, elapsedMs: msg.elapsedMs });
      } else if (msg.type === 'error') {
        fail(new SeparationError(msg.reason, msg.message, true));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault?.();
      fail(new SeparationError('init-failed', `The vocal-isolation engine stopped (${event.message || 'unknown error'}). Reload the app and try again. If you are offline, the engine files may not be on this phone yet (they are fetched the first time, and again after an app update): connect once and try again.`, true));
    };

    const consume = input.consume === true && input.samples.byteOffset === 0 && input.samples.buffer.byteLength === input.samples.byteLength;
    const samples = consume ? input.samples : input.samples.slice();
    const request: SeparatorRunRequest = { type: 'run', model, samples, sampleRate: input.sampleRate, overlap: input.overlap ?? 0 };
    try {
      worker.postMessage(request, [model, samples.buffer]);
    } catch (err) {
      fail(new SeparationError('init-failed', `The vocal-isolation engine could not be given the song (${err instanceof Error ? err.message : String(err)}).`, true));
    }
  });
}

/**
 * Isolates the vocal of `input.samples`. Rejects with a SeparationError (unavailable, model-missing, download-failed, hash-mismatch,
 * init-failed, run-failed) or an AbortError when `input.signal` aborts. Nothing is kept from a failed or cancelled run except
 * a verified model file.
 */
export async function isolateVocal(input: IsolateInput, deps: IsolateDeps = {}): Promise<IsolateResult> {
  const { signal } = input;
  if (signal?.aborted) throw abortError('Vocal isolation was cancelled.');
  const modelDeps = deps.model ?? defaultModelDeps();
  const availability = await checkSeparation({ deps: modelDeps, env: deps.env, signal });
  if (!availability.available || !availability.manifest) {
    if (availability.reason === 'no-manifest' && typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new SeparationError('download-failed', 'You are offline, and the vocal-isolation model is not on this phone yet. Connect once to download it, or add the vocal-only version of the song instead.', true);
    }
    if (availability.reason === 'no-manifest' || availability.reason === 'no-model') {
      throw new SeparationError('model-missing', 'This copy of Mimic does not include the vocal-isolation model, so a song cannot be split here. Add the vocal-only version of the song instead.');
    }
    throw new SeparationError('unavailable', 'Isolating a vocal is not available in this version of the app or on this browser. Add the vocal-only version of the song instead.');
  }
  const manifest = availability.manifest;
  const ensured = await ensureModel(modelDeps, manifest, { signal, onProgress: input.onDownload });
  if (signal?.aborted) throw abortError('Vocal isolation was cancelled.');
  // The model is ready (downloaded or already here): from now on the wait is the engine starting and then the splitting.
  input.onProgress?.({ phase: 'starting', fraction: 0, patch: 0, patches: 0, etaSec: null });

  let worker: Worker;
  try {
    worker = await (deps.createWorker ?? defaultCreateWorker)();
  } catch (err) {
    throw new SeparationError('init-failed', `The vocal-isolation engine could not be started (${err instanceof Error ? err.message : String(err)}).`, false);
  }
  if (signal?.aborted) {
    worker.terminate();
    throw abortError('Vocal isolation was cancelled.');
  }
  const out = await runInWorker(worker, ensured.bytes, input);
  return {
    vocals: out.vocals,
    sampleRate: out.sampleRate,
    model: { name: manifest.name, version: manifest.version },
    patches: out.patches,
    elapsedMs: out.elapsedMs,
    downloaded: ensured.downloaded && !modelDeps.native,
    // The native app's model is part of the app, so it is never "downloaded again".
    modelKept: ensured.cached || modelDeps.native === true,
  };
}
