// The separation worker: loads the vocal-isolation network into onnxruntime-web (WebAssembly, one thread, SIMD) and runs the
// signal pipeline from src/dsp/separate over a song section, patch by patch. A module worker emitted as its own same-origin
// file, with the runtime's .wasm and loader emitted beside it by Vite (see the two `?url` imports): no CDN, no third-party request.
// The page terminates the worker to cancel, so nothing here needs to be interruptible.

import * as ort from 'onnxruntime-web/wasm';
// The runtime's WebAssembly file and its loader. The paths reach into the package because its `exports` map does not list them;
// Vite emits both as hashed assets and gives back their URLs.
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import mjsUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import { separateVocals, type MaskModel } from '../../dsp/separate/separate';
import { scriptBlobUrl, type ScriptBlobUrl } from './loaderUrl';
import type { SeparatorRunRequest, SeparatorWorkerMessage } from './protocol';

const scope = self as unknown as { postMessage(message: SeparatorWorkerMessage, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<SeparatorRunRequest>) => void) | null; location: { href: string } };

function post(message: SeparatorWorkerMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function absolute(url: string): string {
  return new URL(url, scope.location.href).href;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

async function run(req: SeparatorRunRequest): Promise<void> {
  let session: ort.InferenceSession | null = null;
  const loadStart = performance.now();
  let loader: ScriptBlobUrl | null = null;
  try {
    post({ type: 'loading' });
    // The loader is imported from a blob: URL typed text/javascript, so a server that does not know ".mjs" (Capacitor's) cannot break it.
    loader = await scriptBlobUrl(absolute(mjsUrl));
    ort.env.wasm.wasmPaths = { mjs: loader.url, wasm: absolute(wasmUrl) };
    ort.env.wasm.numThreads = 1; // more threads need SharedArrayBuffer, which needs cross-origin isolation headers a static host cannot send
    ort.env.wasm.simd = true;
    ort.env.wasm.proxy = false; // this already is a worker
    ort.env.logLevel = 'error';
    session = await ort.InferenceSession.create(new Uint8Array(req.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  } catch (err) {
    post({ type: 'error', reason: 'init-failed', message: `The vocal-isolation engine could not start (${messageOf(err)}). If you are offline, its files may not be on this phone yet (they are fetched the first time, and again after an app update): connect once and try again.` });
    return;
  } finally {
    loader?.release();
  }
  const loadMs = performance.now() - loadStart;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const model: MaskModel = {
    async run(input) {
      const out = await session!.run({ [inputName]: new ort.Tensor('float32', input, [1, 512, 1024, 2]) });
      return out[outputName].data as Float32Array;
    },
  };
  try {
    const result = await separateVocals({
      channels: [req.samples],
      sampleRate: req.sampleRate,
      model,
      overlap: req.overlap,
      onProgress: (fraction, info) => post({ type: 'progress', fraction, stage: info.stage, patch: info.patch, patches: info.patches }),
    });
    post(
      { type: 'result', vocals: result.vocals, sampleRate: result.sampleRate, patches: result.patches, elapsedMs: result.elapsedMs, loadMs },
      [result.vocals.buffer],
    );
  } catch (err) {
    post({ type: 'error', reason: 'run-failed', message: `Splitting the song failed (${messageOf(err)}). A phone that is low on memory can do this: close other apps and try a shorter part.` });
  } finally {
    await session.release().catch(() => undefined);
  }
}

scope.onmessage = (e) => {
  if (e.data?.type === 'run') void run(e.data);
};
post({ type: 'alive' });
