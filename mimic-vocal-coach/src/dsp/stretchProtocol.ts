// Message protocol between the main thread (stretchClient.ts) and the render worker (stretchWorker.ts), and the worker-side
// job runner. Kept free of worker globals so it can be tested in Node.

import { createGuideJob, type GuideSpec } from './timestretch';

export interface RenderRequest {
  type: 'render';
  id: number;
  samples: Float32Array;
  sampleRate: number;
  spec: GuideSpec;
}

export type RenderResponse =
  /** The worker script is running (the client falls back to the main thread when it never hears this). */
  | { type: 'alive' }
  | { type: 'progress'; id: number; value: number }
  | { type: 'result'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string };

/** Progress is posted about this often (ms) while the job runs. */
const PROGRESS_EVERY_MS = 60;

/** Runs one render request: progress, then exactly one result or error. */
export function runRenderJob(request: RenderRequest, post: (msg: RenderResponse) => void): void {
  const id = typeof request?.id === 'number' ? request.id : -1;
  if (!request || request.type !== 'render' || !(request.samples instanceof Float32Array) || typeof request.spec !== 'object' || request.spec === null) {
    post({ type: 'error', id, message: 'The render worker received an invalid request.' });
    return;
  }
  try {
    const job = createGuideJob(request.samples, request.sampleRate, request.spec);
    while (!job.run(PROGRESS_EVERY_MS)) post({ type: 'progress', id, value: job.progress });
    post({ type: 'result', id, samples: job.result(), sampleRate: request.spec.outRate ?? request.sampleRate });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    post({ type: 'error', id, message: `The guide could not be rendered: ${detail}` });
  }
}
