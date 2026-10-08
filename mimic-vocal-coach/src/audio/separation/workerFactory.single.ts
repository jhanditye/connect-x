// Stands in for workerFactory.ts in the single-file build (vite.config.ts swaps it in): that build is one HTML file and cannot carry
// a worker file or the runtime's .wasm, so vocal isolation reports itself unavailable and never reaches this. It exists so the
// worker, onnxruntime-web and the model are not linked into that file at all.

export function createSeparatorWorker(): Worker {
  throw new Error('Vocal isolation is not part of the single-file build.');
}
