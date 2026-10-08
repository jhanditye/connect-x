// Why vocal isolation could not run, as a type the screens can branch on. Every message names the next step.

export type SeparationFailure =
  /** This build or browser cannot do it at all (single-file build, no WebAssembly, no workers, plain-HTTP page). */
  | 'unavailable'
  /** The site does not carry the model file. */
  | 'model-missing'
  /** The download failed or stopped short; trying again can help. */
  | 'download-failed'
  /** The downloaded file is not the one the manifest describes. It was thrown away. */
  | 'hash-mismatch'
  /** The model was fetched but the phone would not keep it (storage full): it is used this once and fetched again next time. */
  | 'storage-full'
  /** The worker or the runtime could not start (blocked script, no memory, unsupported browser). */
  | 'init-failed'
  /** The network ran on a patch and failed (memory ran out, bad output). */
  | 'run-failed';

export class SeparationError extends Error {
  readonly reason: SeparationFailure;
  /** True when trying again, now or later, can plausibly work. */
  readonly retryable: boolean;
  constructor(reason: SeparationFailure, message: string, retryable = false) {
    super(message);
    this.name = 'SeparationError';
    this.reason = reason;
    this.retryable = retryable;
  }
}

export function isSeparationError(err: unknown): err is SeparationError {
  return err instanceof SeparationError;
}
