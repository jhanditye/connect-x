// Messages between the page and the separation worker. Plain data, no imports, so both sides and the tests share one definition.

export interface SeparatorRunRequest {
  type: 'run';
  /** The verified model file. Transferred, so the page does not keep a second copy. */
  model: ArrayBuffer;
  /** Mono samples of the song section. */
  samples: Float32Array;
  sampleRate: number;
  overlap: 0 | 0.5;
}

export type SeparatorWorkerMessage =
  /** The script is running (a worker that never says this was blocked). */
  | { type: 'alive' }
  /** The network is being loaded into the runtime. */
  | { type: 'loading' }
  | { type: 'progress'; fraction: number; stage: string; patch: number; patches: number }
  | { type: 'result'; vocals: Float32Array; sampleRate: number; patches: number; elapsedMs: number; loadMs: number }
  | { type: 'error'; reason: 'init-failed' | 'run-failed'; message: string };
