// Web Worker entry: runs analyzeTake off the main thread.
// in:  { type: 'analyze', samples: Float32Array, sampleRate: number, opts: AnalysisOptions }
// out: { type: 'progress', value: number } | { type: 'result', analysis: VoiceAnalysis } | { type: 'error', message: string }

import { runAnalysisJob, type AnalyzeRequest, type WorkerResponse } from './workerProtocol';

export type { AnalyzeRequest, WorkerResponse } from './workerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  runAnalysisJob(event.data, (msg: WorkerResponse) => scope.postMessage(msg));
};

// "I am alive" ping (a progress of 0, so the protocol is unchanged). The client falls back to the main
// thread when it never hears from the worker, which can happen when a browser accepts a module worker
// from a blob: URL but never runs it.
scope.postMessage({ type: 'progress', value: 0 } satisfies WorkerResponse);
