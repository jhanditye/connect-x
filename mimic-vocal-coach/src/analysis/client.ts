// Main-thread entry point for analysis. Runs analyzeTake in a Web Worker so the UI stays
// responsive, and falls back to the main thread when workers are unavailable (old browsers,
// some sandboxed iframes, strict CSPs that block blob: workers).

import type { AnalysisOptions, VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';
import AnalysisWorker from './worker?worker&inline';
import type { AnalyzeRequest, WorkerResponse } from './workerProtocol';

function analyzeOnMainThread(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
): Promise<VoiceAnalysis> {
  // Deferred so the caller's "Analysing..." state can paint before the synchronous work starts.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(analyzeTake(samples, sampleRate, opts, onProgress));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }, 0);
  });
}

/** A worker that has not said anything for this long (it pings as soon as its script runs) is treated as dead. */
const WORKER_START_TIMEOUT_MS = 6000;

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new AnalysisWorker();
  } catch {
    return null;
  }
}

/** Runs analyzeTake in a Web Worker (import with `?worker&inline` so single-file builds work). Falls back to the main thread if workers are unavailable. */
export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
): Promise<VoiceAnalysis> {
  const worker = createWorker();
  if (!worker) return analyzeOnMainThread(samples, sampleRate, opts, onProgress);

  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      settled = true;
      clearTimeout(startTimer);
      worker.terminate();
    };
    startTimer = setTimeout(() => {
      if (started || settled) return;
      finish();
      analyzeOnMainThread(samples, sampleRate, opts, onProgress).then(resolve, reject);
    }, WORKER_START_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (settled) return;
      const msg = event.data;
      started = true;
      if (msg.type === 'progress') onProgress?.(msg.value);
      else if (msg.type === 'result') {
        finish();
        resolve(msg.analysis);
      } else if (msg.type === 'error') {
        finish();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (event: ErrorEvent) => {
      if (settled) return;
      event.preventDefault();
      finish();
      // A worker that never got going (blocked script, unsupported module worker) is an
      // environment problem, not an analysis failure: do the work here instead.
      if (!started) analyzeOnMainThread(samples, sampleRate, opts, onProgress).then(resolve, reject);
      else reject(new Error(event.message || 'The analysis worker stopped unexpectedly.'));
    };
    // Transfer a copy so the caller keeps its samples (they are still needed for playback,
    // download and the main-thread fallback).
    const copy = samples.slice();
    const request: AnalyzeRequest = { type: 'analyze', samples: copy, sampleRate, opts };
    try {
      worker.postMessage(request, [copy.buffer]);
    } catch {
      finish();
      analyzeOnMainThread(samples, sampleRate, opts, onProgress).then(resolve, reject);
    }
  });
}
