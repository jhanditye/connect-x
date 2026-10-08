// Is the optional on-device vocal isolation complete in a built web folder (www/ or ios/App/App/public)?
//
// The feature needs four things at run time that nothing links statically, so a normal "every file index.html references is
// present" check cannot see them missing: the model file (public/models/vocal-isolation.onnx, git-ignored, about 20 MB), the manifest
// that describes it, the WebAssembly engine and its loader (assets/ort-wasm-simd-threaded-*.wasm / *.mjs) and the worker
// (assets/separator.worker-*.js). Without the model the app still builds and runs; the option just never appears.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root a built web folder
 * @returns {{ included: boolean, hasManifest: boolean, problems: string[], summary: string }}
 *   included: everything is there; hasManifest: the site claims the feature; problems: what is missing or does not match.
 */
export function inspectIsolation(root) {
  const manifestPath = path.join(root, 'models', 'vocal-isolation.json');
  if (!fs.existsSync(manifestPath)) {
    return { included: false, hasManifest: false, problems: [], summary: 'no models/vocal-isolation.json: this build does not offer vocal isolation' };
  }
  const problems = [];
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    problems.push('models/vocal-isolation.json is not valid JSON');
  }
  const modelPath = path.join(root, 'models', 'vocal-isolation.onnx');
  if (!fs.existsSync(modelPath)) {
    problems.push('models/vocal-isolation.onnx is missing (it is not committed: copy it in with `node ../scripts/prepare-separator-model.mjs --from <file>` in the web project, then rebuild)');
  } else if (manifest && typeof manifest.bytes === 'number' && fs.statSync(modelPath).size !== manifest.bytes) {
    problems.push(`models/vocal-isolation.onnx is ${fs.statSync(modelPath).size} bytes but its manifest says ${manifest.bytes}`);
  }
  const assets = path.join(root, 'assets');
  const has = (re) => fs.existsSync(assets) && fs.readdirSync(assets).some((f) => re.test(f));
  if (!has(/^ort-wasm-simd-threaded-.*\.wasm$/)) problems.push('assets/ort-wasm-simd-threaded-*.wasm (the engine) is missing');
  if (!has(/^ort-wasm-simd-threaded-.*\.mjs$/)) problems.push('assets/ort-wasm-simd-threaded-*.mjs (the engine loader) is missing');
  if (!has(/^separator\.worker-.*\.js$/)) problems.push('assets/separator.worker-*.js (the worker) is missing');
  return {
    included: problems.length === 0,
    hasManifest: true,
    problems,
    summary: problems.length === 0 ? 'model, manifest, engine and worker are all present' : problems.join('; '),
  };
}
