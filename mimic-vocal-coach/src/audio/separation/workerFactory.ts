// The only place the separation worker is created. Kept in its own module so the page loads it with a dynamic import, and the
// single-file build (which cannot carry a worker file or the runtime's .wasm) never reaches it: see client.ts and vite.config.ts.

export function createSeparatorWorker(): Worker {
  return new Worker(new URL('./separator.worker.ts', import.meta.url), { type: 'module' });
}
