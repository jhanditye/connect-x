// Web Worker entry: runs analyzeTake off the main thread.
// in:  { type: 'analyze', samples: Float32Array, sampleRate: number, opts: AnalysisOptions }
// out: { type: 'progress', value: number } | { type: 'result', analysis: VoiceAnalysis } | { type: 'error', message: string }

import { runAnalysisJob, type AnalyzeRequest, type WorkerResponse } from './workerProtocol';

export type { AnalyzeRequest, WorkerResponse } from './workerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  runAnalysisJob(event.data, (msg: WorkerResponse) => scope.postMessage(msg));
};
