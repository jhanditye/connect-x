// The native-app build must notice when the vocal-isolation model, engine or worker is not in the bundle (they are loaded at run time,
// and the 20 MB model is git-ignored). ios-native/scripts/lib/isolation.mjs is the check build-web, verify and make-zip share.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = join(import.meta.dirname, '..', 'ios-native', 'scripts', 'lib', 'isolation.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function inspect(root: string): { included: boolean; hasManifest: boolean; problems: string[] } {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import { inspectIsolation } from ${JSON.stringify('file://' + helper)}; console.log(JSON.stringify(inspectIsolation(process.argv[1])));`, root], { encoding: 'utf8' });
  return JSON.parse(out);
}

function bundle(parts: { manifest?: boolean; model?: number | false; wasm?: boolean; mjs?: boolean; worker?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'mimic-iso-'));
  dirs.push(root);
  mkdirSync(join(root, 'models'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  if (parts.manifest !== false) writeFileSync(join(root, 'models', 'vocal-isolation.json'), JSON.stringify({ bytes: 10 }));
  if (parts.model !== false) writeFileSync(join(root, 'models', 'vocal-isolation.onnx'), Buffer.alloc(parts.model ?? 10));
  if (parts.wasm !== false) writeFileSync(join(root, 'assets', 'ort-wasm-simd-threaded-AbC123.wasm'), 'w');
  if (parts.mjs !== false) writeFileSync(join(root, 'assets', 'ort-wasm-simd-threaded-AbC123.mjs'), 'm');
  if (parts.worker !== false) writeFileSync(join(root, 'assets', 'separator.worker-XyZ789.js'), 'j');
  return root;
}

describe('native bundle: vocal isolation completeness', () => {
  it('a complete bundle passes', () => {
    expect(inspect(bundle({}))).toMatchObject({ included: true, hasManifest: true, problems: [] });
  });

  it('a build made where the model was never prepared is reported (the manifest is committed, the model is not)', () => {
    const r = inspect(bundle({ model: false }));
    expect(r.included).toBe(false);
    expect(r.hasManifest).toBe(true);
    expect(r.problems.join(' ')).toMatch(/vocal-isolation\.onnx is missing/);
  });

  it('a model of the wrong size, and each missing engine part, are reported', () => {
    expect(inspect(bundle({ model: 7 })).problems.join(' ')).toMatch(/is 7 bytes but its manifest says 10/);
    expect(inspect(bundle({ wasm: false })).problems.join(' ')).toMatch(/\.wasm \(the engine\)/);
    expect(inspect(bundle({ mjs: false })).problems.join(' ')).toMatch(/\.mjs \(the engine loader\)/);
    expect(inspect(bundle({ worker: false })).problems.join(' ')).toMatch(/separator\.worker/);
  });

  it('a site without a manifest simply does not offer the feature', () => {
    expect(inspect(bundle({ manifest: false, model: false, wasm: false, mjs: false, worker: false }))).toMatchObject({ included: false, hasManifest: false, problems: [] });
  });
});
