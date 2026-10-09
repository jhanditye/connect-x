// Assembles the Mac download from a finished web build:
//
//   npm run build:mac          (= vite build, then this script)
//
// dist-mac/Mimic-for-Mac/
//   Start Mimic.command    double-click launcher (mode 755)
//   server.pl              the tiny local web server (core Perl, nothing to install)
//   README.txt             plain-text instructions for a non-developer
//   app/                   a copy of dist/ (including models/ when the build has the vocal-isolation model)
// dist-mac/Mimic-for-Mac.zip   the same folder, zipped with the system `zip`, executable bits kept
//
// Safe to run again: it rebuilds both from scratch. It fails (exit 1) if dist/ is missing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // not import.meta.dirname: that needs Node 20.11
const dist = path.join(root, 'dist');
const macSrc = path.join(root, 'mac');
const outDir = path.join(root, 'dist-mac');
const folderName = 'Mimic-for-Mac';
const bundle = path.join(outDir, folderName);
const zipPath = path.join(outDir, `${folderName}.zip`);
const LAUNCHER = 'Start Mimic.command';

function fail(message) {
  console.error(`make-mac-bundle: ${message}`);
  process.exit(1);
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`; // decimal, like Finder

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

// ---- inputs
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  fail('dist/index.html is missing. Build the web app first: `npx vite build` (or run `npm run build:mac`, which does it for you).');
}
if (!fs.existsSync(path.join(dist, 'sw.js'))) {
  fail('dist/sw.js is missing, so dist/ is not the normal multi-file build (the single-file build cannot be used here). Run `npx vite build`.');
}
// What the launcher and the server depend on in the build: the launcher decides "this port is Mimic" by looking for this name in
// the manifest, and the server serves the files from a folder of its own, so every asset address must be relative or start at "/".
const manifestText = fs.existsSync(path.join(dist, 'manifest.webmanifest')) ? fs.readFileSync(path.join(dist, 'manifest.webmanifest'), 'utf8') : '';
if (!manifestText.includes('Mimic Vocal Coach')) {
  fail('dist/manifest.webmanifest is missing or no longer contains "Mimic Vocal Coach". The launcher recognises a running Mimic by that name: change it in mac/Start Mimic.command too, then rebuild.');
}
const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
for (const m of indexHtml.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
  if (/^(?:https?:)?\/\//i.test(m[1] ?? '')) fail(`dist/index.html loads ${m[1]} from the internet; the Mac bundle must work offline.`);
}
if (!/<script[^>]+src="(?:\.\/|\/)assets\//.test(indexHtml)) fail('dist/index.html has no script under ./assets/ or /assets/, so the server would not find the app. Check vite `base`.');
for (const name of [LAUNCHER, 'server.pl', 'README.txt']) {
  if (!fs.existsSync(path.join(macSrc, name))) fail(`mac/${name} is missing from the project.`);
}
const launcher = fs.readFileSync(path.join(macSrc, LAUNCHER), 'utf8');
if (!launcher.startsWith('#!/bin/bash\n')) fail(`mac/${LAUNCHER} must start with "#!/bin/bash" and Unix line endings.`);
if (launcher.includes('\r')) fail(`mac/${LAUNCHER} contains carriage returns (Windows line endings); macOS would refuse to run it.`);
if (fs.readFileSync(path.join(macSrc, 'server.pl'), 'utf8').includes('\r')) fail('mac/server.pl contains carriage returns (Windows line endings).');

// ---- assemble
fs.rmSync(bundle, { recursive: true, force: true });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(bundle, { recursive: true });
// dist-mac holds a copy of the git-ignored 20 MB model: keep the whole folder out of version control without touching .gitignore.
fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n');

fs.cpSync(dist, path.join(bundle, 'app'), {
  recursive: true,
  preserveTimestamps: true,
  filter: (src) => path.basename(src) !== '.DS_Store',
});
fs.copyFileSync(path.join(macSrc, 'server.pl'), path.join(bundle, 'server.pl'));
fs.chmodSync(path.join(bundle, 'server.pl'), 0o755);
fs.copyFileSync(path.join(macSrc, LAUNCHER), path.join(bundle, LAUNCHER));
fs.chmodSync(path.join(bundle, LAUNCHER), 0o755);
fs.copyFileSync(path.join(macSrc, 'README.txt'), path.join(bundle, 'README.txt'));
fs.chmodSync(path.join(bundle, 'README.txt'), 0o644);

// ---- vocal isolation: is everything the feature loads at run time in the copy?
const appDir = path.join(bundle, 'app');
const modelFile = path.join(appDir, 'models', 'vocal-isolation.onnx');
const manifestFile = path.join(appDir, 'models', 'vocal-isolation.json');
const problems = [];
let modelBytes = 0;
if (!fs.existsSync(manifestFile)) {
  problems.push('app/models/vocal-isolation.json is absent');
} else {
  let expected = null;
  try {
    expected = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).bytes;
  } catch {
    problems.push('app/models/vocal-isolation.json is not valid JSON');
  }
  if (!fs.existsSync(modelFile)) {
    problems.push('app/models/vocal-isolation.onnx is absent (it is git-ignored: put it in public/models/ with scripts/prepare-separator-model.mjs and rebuild)');
  } else {
    modelBytes = fs.statSync(modelFile).size;
    if (typeof expected === 'number' && expected !== modelBytes) problems.push(`app/models/vocal-isolation.onnx is ${modelBytes} bytes but its manifest says ${expected}`);
  }
}
const assets = fs.existsSync(path.join(appDir, 'assets')) ? fs.readdirSync(path.join(appDir, 'assets')) : [];
for (const [re, what] of [
  [/^ort-wasm-simd-threaded-.*\.wasm$/, 'engine (.wasm)'],
  [/^ort-wasm-simd-threaded-.*\.mjs$/, 'engine loader (.mjs)'],
  [/^separator\.worker-.*\.js$/, 'separation worker'],
]) {
  if (!assets.some((f) => re.test(f))) problems.push(`app/assets/ has no ${what}`);
}

// ---- zip (system zip: Unix permissions are stored, so the launcher stays executable once unzipped on a Mac)
const z = spawnSync('zip', ['-r', '-X', '-q', zipPath, folderName, '-x', '*.DS_Store'], { cwd: outDir, encoding: 'utf8' });
if (z.error) fail(`could not run the system \`zip\` (${z.error.message}). Install zip, or zip dist-mac/${folderName} by hand.`);
if (z.status !== 0) fail(`zip failed (exit ${z.status}): ${(z.stderr || z.stdout || '').trim()}`);

// ---- check the zip really carries the executable bit on the launcher (a lost bit means "permission denied" on the Mac)
let permNote = 'executable bit not verified (no `unzip` on this machine)';
const info = spawnSync('unzip', ['-Z', zipPath], { encoding: 'utf8' });
if (!info.error && info.status === 0) {
  const line = info.stdout.split('\n').find((l) => l.includes(`${folderName}/${LAUNCHER}`));
  if (!line) fail(`the zip has no ${folderName}/${LAUNCHER}.`);
  if (!/^-rwx/.test(line)) fail(`${LAUNCHER} is not executable inside the zip (${line.slice(0, 10)}).`);
  permNote = `${LAUNCHER} is executable inside the zip`;
}

// ---- report
const appBytes = dirSize(appDir);
console.log(`make-mac-bundle: ${path.relative(root, bundle)}/`);
console.log(`  app/                ${mb(appBytes)}${modelBytes ? ` (of which the vocal-isolation model ${mb(modelBytes)})` : ''}`);
console.log(`  ${LAUNCHER}, server.pl, README.txt`);
console.log(`  folder total        ${mb(dirSize(bundle))}`);
console.log(`  zip                 ${path.relative(root, zipPath)}  ${mb(fs.statSync(zipPath).size)}`);
console.log(`  ${permNote}`);
if (problems.length === 0) {
  console.log('  vocal isolation:    included (model, manifest, engine and worker are all in app/)');
} else {
  console.warn(`  vocal isolation:    NOT usable in this bundle: ${problems.join('; ')}`);
}
