// Message protocol between the main thread (client.ts) and the analysis worker (worker.ts), and
// the worker-side job runner. Kept free of worker globals so it can be tested in Node.

import type { AnalysisOptions, VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';

export interface AnalyzeRequest {
  type: 'analyze';
  /** Mono samples at any rate. For a full song (opts.mode 'mix') this is the mono mix; a second channel is not carried yet. */
  samples: Float32Array;
  sampleRate: number;
  /** `opts.mode` 'mix' runs the full-song analysis (analysis/mixMode.ts); absent or 'solo' the normal one. */
  opts: AnalysisOptions;
}

export type WorkerResponse =
  | { type: 'progress'; value: number }
  | { type: 'result'; analysis: VoiceAnalysis }
  | { type: 'error'; message: string };

/** Progress messages are throttled to steps of at least this much (plus the final 1). */
const PROGRESS_STEP = 0.02;

/** Runs one analysis request, reporting progress and then exactly one result or error. */
export function runAnalysisJob(request: AnalyzeRequest, post: (msg: WorkerResponse) => void): void {
  if (!request || request.type !== 'analyze' || !(request.samples instanceof Float32Array)) {
    post({ type: 'error', message: 'The analysis worker received an invalid request.' });
    return;
  }
  let lastSent = -1;
  try {
    const analysis = analyzeTake(request.samples, request.sampleRate, request.opts, (value) => {
      if (value >= 1 || value - lastSent >= PROGRESS_STEP) {
        lastSent = value;
        post({ type: 'progress', value });
      }
    });
    post({ type: 'result', analysis });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message: `The analysis failed: ${detail}` });
  }
}
