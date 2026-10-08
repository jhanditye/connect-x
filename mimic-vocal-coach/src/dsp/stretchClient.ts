// Main-thread entry point for rendering a slowed and/or transposed guide. Runs the WSOLA render in a Web Worker so the page
// keeps painting (the 12 s phrase of the trainer takes 0.1 to 0.5 s of CPU on a desktop and more on a phone), and falls back
// to rendering in 8 ms slices on the main thread when workers are unavailable (old browsers, some sandboxed iframes, strict
// CSPs that block blob: workers). Same shape as analysis/client.ts.

import type { RenderRequest, RenderResponse } from './stretchProtocol';
import StretchWorker from './stretchWorker?worker&inline';
import { abortError, renderGuideAsync, type GuideSpec } from './timestretch';

export interface GuideRender {
  samples: Float32Array;
  /** The rate of `samples` (spec.outRate when the conversion happened, else the input rate). */
  sampleRate: number;
  viaWorker: boolean;
  /** Wall time from the call to the result, ms. */
  ms: number;
}

/** The part of Worker the client uses; tests pass a fake. */
export interface WorkerLike {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: RenderRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface RenderClientOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Skip the worker (tests, diagnostics comparing both paths). */
  forceMainThread?: boolean;
  /** How long to wait for the worker's "alive" message before rendering here instead. Default 4000 ms. */
  startTimeoutMs?: number;
  /** Replaceable for tests. Default: the bundled inline worker, or null when Worker does not exist. */
  createWorker?: () => WorkerLike | null;
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function defaultCreateWorker(): WorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new StretchWorker() as unknown as WorkerLike;
  } catch {
    return null;
  }
}

let nextId = 1;

async function renderHere(samples: Float32Array, sampleRate: number, spec: GuideSpec, opts: RenderClientOptions, t0: number): Promise<GuideRender> {
  // The sample-rate conversion and the pitch shift are cut into slices like the stretch, so nothing blocks for long.
  const out = await renderGuideAsync(samples, sampleRate, spec, { signal: opts.signal, onProgress: opts.onProgress });
  return { samples: out, sampleRate: spec.outRate ?? sampleRate, viaWorker: false, ms: clock() - t0 };
}

/** Renders `samples` at `spec`. Rejects with an AbortError when `opts.signal` aborts; render errors reject with a plain Error. */
export function renderGuideOffMainThread(samples: Float32Array, sampleRate: number, spec: GuideSpec, opts: RenderClientOptions = {}): Promise<GuideRender> {
  const t0 = clock();
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const worker = opts.forceMainThread ? null : (opts.createWorker ?? defaultCreateWorker)();
  if (!worker) return renderHere(samples, sampleRate, spec, opts, t0);

  return new Promise<GuideRender>((resolve, reject) => {
    const id = nextId++;
    let settled = false;
    let started = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      if (settled) return;
      cleanup();
      reject(abortError());
    };
    function cleanup(): void {
      settled = true;
      clearTimeout(startTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      worker!.onmessage = null;
      worker!.onerror = null;
      worker!.terminate();
    }
    /** The worker never got going (blocked script, unsupported module worker): do the work here. */
    const fallBack = (): void => {
      cleanup();
      renderHere(samples, sampleRate, spec, opts, t0).then(resolve, reject);
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    startTimer = setTimeout(() => {
      if (!started && !settled) fallBack();
    }, opts.startTimeoutMs ?? 4000);

    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      if (settled) return;
      const msg = event.data;
      started = true;
      clearTimeout(startTimer);
      if (msg.type === 'alive') return;
      if (msg.id !== id) return;
      if (msg.type === 'progress') opts.onProgress?.(msg.value);
      else if (msg.type === 'result') {
        cleanup();
        opts.onProgress?.(1);
        resolve({ samples: msg.samples, sampleRate: msg.sampleRate, viaWorker: true, ms: clock() - t0 });
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      event.preventDefault?.();
      if (!started) fallBack();
      else {
        cleanup();
        reject(new Error(event.message || 'The render worker stopped unexpectedly.'));
      }
    };
    // A transferred copy: the caller keeps its samples (the main-thread fallback and playback still need them).
    const copy = samples.slice();
    try {
      worker.postMessage({ type: 'render', id, samples: copy, sampleRate, spec }, [copy.buffer]);
    } catch {
      fallBack();
    }
  });
}
