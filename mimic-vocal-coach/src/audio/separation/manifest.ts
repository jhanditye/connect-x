// The model manifest: public/models/vocal-isolation.json, written by scripts/prepare-separator-model.mjs next to the model file.
// The manifest is committed, the model file is not (too big), so the manifest is what the app asks first: absent means the
// feature is not offered. Everything here is plain data and runs anywhere.

/** Paths relative to the app's address (the page's base), so the same build works at a domain root and under /repo/. */
export const MODEL_MANIFEST_PATH = 'models/vocal-isolation.json';
export const MODEL_FILE_PATH = 'models/vocal-isolation.onnx';

/** Nothing bigger than this is downloaded, whatever the manifest says (a wrong manifest must not fill the phone). */
export const MAX_MODEL_BYTES = 160 * 1024 * 1024;

export interface ModelManifest {
  name: string;
  version: string;
  /** Exact size of the model file. */
  bytes: number;
  /** Lower-case hex SHA-256 of the model file. */
  sha256: string;
  /** The licence of the model, as a sentence the app can show. */
  licence: string;
  /** Where the model came from. */
  source: string;
  /** The sample rate the network works at (the signal pipeline resamples to it). */
  inputRate: number;
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x.trim() : null;
}

/** The manifest from parsed JSON, or null when anything is missing or out of range. */
export function parseManifest(x: unknown): ModelManifest | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const name = str(r.name);
  const version = str(r.version);
  const sha256 = str(r.sha256)?.toLowerCase() ?? null;
  const licence = str(r.licence);
  const source = str(r.source);
  const bytes = r.bytes;
  const inputRate = r.inputRate;
  if (!name || !version || !licence || !source) return null;
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_MODEL_BYTES) return null;
  if (typeof inputRate !== 'number' || !Number.isFinite(inputRate) || inputRate < 8000 || inputRate > 192000) return null;
  return { name, version, bytes, sha256, licence, source, inputRate };
}
