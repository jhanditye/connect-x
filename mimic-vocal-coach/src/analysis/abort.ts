// The one way an analysis (or an import) says "you cancelled me": a DOMException named AbortError, so callers can tell a
// cancel from a failure with isAbortError and show nothing.

export function abortError(message = 'The analysis was cancelled.'): Error {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}
