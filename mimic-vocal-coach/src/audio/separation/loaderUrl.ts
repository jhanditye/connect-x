// onnxruntime-web starts its WebAssembly runtime by import()ing a small JavaScript loader (an .mjs file). A browser only runs a
// module script that is served with a JavaScript MIME type, and a static server picks the type from the file extension: Capacitor's
// local server (the iPhone app) has no entry for ".mjs" and would answer application/octet-stream, which stops the engine before it
// starts. Fetching the loader's text and importing it from a blob: URL with an explicit text/javascript type makes the load
// independent of what the server says. The worker runs on its own origin and fetches only this site's file.

export interface ScriptBlobDeps {
  fetchText(url: string): Promise<string>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

const defaultDeps: ScriptBlobDeps = {
  async fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the engine file ${url} answered ${res.status}`);
    return res.text();
  },
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

export interface ScriptBlobUrl {
  /** What to import(): a blob: URL, or the original URL when a blob could not be made. */
  url: string;
  /** Give the blob back once the module has been imported. Safe to call more than once. */
  release(): void;
}

/** The text of the script at `url` as a blob: URL of type text/javascript. Falls back to `url` itself if that cannot be done. */
export async function scriptBlobUrl(url: string, deps: ScriptBlobDeps = defaultDeps): Promise<ScriptBlobUrl> {
  let blobUrl: string | null = null;
  try {
    const text = await deps.fetchText(url);
    blobUrl = deps.createObjectURL(new Blob([text], { type: 'text/javascript' }));
  } catch {
    // No blob (fetch refused, object URLs unavailable): let the runtime try the plain URL, which is right on a server that sends the right type.
    blobUrl = null;
  }
  const made = blobUrl;
  return {
    url: made ?? url,
    release() {
      if (made !== null && blobUrl !== null) {
        blobUrl = null;
        deps.revokeObjectURL(made);
      }
    },
  };
}
