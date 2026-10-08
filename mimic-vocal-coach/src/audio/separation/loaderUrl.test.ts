import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { scriptBlobUrl, type ScriptBlobDeps } from './loaderUrl';

function deps(over: Partial<ScriptBlobDeps> = {}): ScriptBlobDeps & { blobs: Blob[] } {
  const blobs: Blob[] = [];
  return {
    blobs,
    fetchText: vi.fn(async () => 'export default 1;'),
    createObjectURL: vi.fn((b: Blob) => {
      blobs.push(b);
      return `blob:test/${blobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
    ...over,
  };
}

describe('scriptBlobUrl', () => {
  it('serves the loader text from a blob typed text/javascript, whatever type the server sent', async () => {
    const d = deps();
    const out = await scriptBlobUrl('https://x.test/assets/ort.mjs', d);
    expect(d.fetchText).toHaveBeenCalledWith('https://x.test/assets/ort.mjs');
    expect(out.url).toBe('blob:test/1');
    expect(d.blobs[0].type).toBe('text/javascript');
    expect(await d.blobs[0].text()).toBe('export default 1;');
  });

  it('gives the blob back once, however often release is called', async () => {
    const d = deps();
    const out = await scriptBlobUrl('https://x.test/a.mjs', d);
    out.release();
    out.release();
    expect(d.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(d.revokeObjectURL).toHaveBeenCalledWith('blob:test/1');
  });

  it('falls back to the plain URL when the text cannot be fetched or a blob cannot be made', async () => {
    const d1 = deps({ fetchText: vi.fn(async () => { throw new Error('offline'); }) });
    const a = await scriptBlobUrl('https://x.test/a.mjs', d1);
    expect(a.url).toBe('https://x.test/a.mjs');
    a.release();
    expect(d1.revokeObjectURL).not.toHaveBeenCalled();
    const d2 = deps({ createObjectURL: vi.fn(() => { throw new Error('no blobs'); }) });
    expect((await scriptBlobUrl('https://x.test/b.mjs', d2)).url).toBe('https://x.test/b.mjs');
  });
});

describe('the separation worker', () => {
  // The worker cannot be run here, so pin the wiring: the loader must go through scriptBlobUrl, never straight to wasmPaths.
  const source = readFileSync(new URL('./separator.worker.ts', import.meta.url), 'utf8');

  it('imports the onnxruntime loader from a blob URL, so it does not depend on the server knowing ".mjs"', () => {
    expect(source).toMatch(/scriptBlobUrl\(absolute\(mjsUrl\)\)/);
    expect(source).toMatch(/mjs:\s*loader\.url/);
    expect(source).not.toMatch(/mjs:\s*absolute\(mjsUrl\)/);
    expect(source).toMatch(/loader\?\.release\(\)/);
  });
});
