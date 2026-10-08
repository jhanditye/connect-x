// Puts the Mimic web app into ios-native/www, which is Capacitor's webDir (what `cap sync` copies into the app).
//
//   npm run build:web                               build the Vite project one folder up (type-check + vite build)
//   npm run build:web -- --no-typecheck             same, but skip `tsc -b` and call `vite build` directly
//   npm run build:web -- --from /path/to/site       do not build anything: copy an already built site (for example the
//                                                   unzipped mimic-pwa.zip) into www
//   npm run build:web -- --out check-www            write to another folder inside ios-native/ (used for dry runs)
//   npm run build:web -- --require-isolation        fail (instead of warning) when the vocal-isolation model, engine or worker is missing
//
// Nothing here ever writes to ../dist. After the build or copy, the PWA service worker (sw.js) is removed from the
// copy that goes into the app: iOS only allows service workers in a WKWebView for "app-bound domains", so it can
// never run there, and a stale one must not be able to pin an old version of the app. The files are then checked:
// index.html must exist and every local file it references must be present, with no root-absolute URLs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectIsolation } from './lib/isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, '..');
const webRoot = path.resolve(nativeDir, '..');

function fail(message) {
  console.error(`\nbuild-web: ${message}\n`);
  process.exit(1);
}

function option(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) fail(`${name} needs a value.`);
  return v;
}

const skipTypecheck = process.argv.includes('--no-typecheck');
const requireIsolation = process.argv.includes('--require-isolation');
const from = option('--from');
const outDir = path.resolve(nativeDir, option('--out') ?? 'www');

if (outDir === nativeDir || !outDir.startsWith(nativeDir + path.sep)) {
  fail(`refusing to write to ${outDir}; the output must be a folder inside ${nativeDir}.`);
}
if (['ios', 'scripts', 'assets', 'node_modules'].includes(path.relative(nativeDir, outDir))) {
  fail(`${path.relative(nativeDir, outDir)}/ is part of this project, pick another --out folder.`);
}

if (from) {
  // Copy a prebuilt site.
  const src = path.resolve(from);
  if (!fs.existsSync(path.join(src, 'index.html'))) fail(`${src} has no index.html. Point --from at the folder that contains index.html.`);
  if (src === outDir || outDir.startsWith(src + path.sep) || src.startsWith(outDir + path.sep)) fail('--from and the output folder must not contain each other.');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(src, outDir, { recursive: true });
  console.log(`build-web: copied ${src} -> ${path.relative(nativeDir, outDir)}/`);
} else {
  if (!fs.existsSync(path.join(webRoot, 'package.json')) || !fs.existsSync(path.join(webRoot, 'index.html'))) {
    fail(
      `expected the Mimic web app one folder above ios-native/, but ${webRoot} has no package.json and index.html.\n` +
        `If you only have a built site (for example mimic-pwa.zip), unzip it and run:\n\n    npm run build:web -- --from /path/to/unzipped/site\n`,
    );
  }
  if (!fs.existsSync(path.join(webRoot, 'node_modules', 'vite'))) {
    fail(`the web app's dependencies are not installed.\nRun this once, then try again:\n\n    npm --prefix .. install\n`);
  }
  // `tsc -b` is the web app's own gate (its `npm run build` is `tsc -b && vite build`). The local binaries are called
  // through `npx --no-install`, so nothing is downloaded and the web app's pinned versions are used.
  const viteArgs = ['vite', 'build', '--outDir', outDir, '--emptyOutDir'];
  const steps = skipTypecheck ? [viteArgs] : [['tsc', '-b'], viteArgs];
  for (const step of steps) {
    console.log(`\n> ${step.join(' ')}   (in ${webRoot})`);
    const r = spawnSync('npx', ['--no-install', ...step], { cwd: webRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) fail(`"${step.join(' ')}" failed (exit ${r.status}). Fix the web app first, or add --no-typecheck to skip tsc.`);
  }
}

// Remove what must not ship inside the app.
const removed = [];
for (const name of ['sw.js', '.DS_Store']) {
  const p = path.join(outDir, name);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
    removed.push(name);
  }
}

// Sanity check the result.
const indexPath = path.join(outDir, 'index.html');
if (!fs.existsSync(indexPath)) fail(`${indexPath} was not produced.`);
const html = fs.readFileSync(indexPath, 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)].map((m) => m[1]).filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u));
const absolute = refs.filter((u) => u.startsWith('/'));
if (absolute.length) fail(`index.html has root-absolute URLs (${absolute.join(', ')}). They cannot work inside the app; the Vite base must stay "./".`);
const missing = refs.filter((u) => !fs.existsSync(path.join(outDir, u.replace(/^\.\//, ''))));
if (missing.length) fail(`index.html refers to files that are missing: ${missing.join(', ')}`);

let files = 0;
let bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
})(outDir);

// A small stamp so you can tell on the phone (and in the zip) which web build is inside the app.
let webPkg = {};
try {
  webPkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
} catch {
  // --from on a machine without the web project: the stamp just has no app name.
}
fs.writeFileSync(
  path.join(outDir, 'native-build.json'),
  JSON.stringify({ app: webPkg.name ?? null, version: webPkg.version ?? null, source: from ? 'prebuilt site (--from)' : 'vite build', builtAt: new Date().toISOString(), files, bytes, removed }, null, 2) + '\n',
);

// Vocal isolation (optional) is loaded at run time, so the check above cannot see it missing. The manifest is committed but the 20 MB
// model is not: a build made where the model was never prepared would ship an app that silently never offers the feature.
const iso = inspectIsolation(outDir);
if (iso.hasManifest && !iso.included) {
  const lines = iso.problems.map((p) => `  - ${p}`).join('\n');
  if (requireIsolation) fail(`vocal isolation is not complete in this build:\n${lines}`);
  console.warn(`\nbuild-web: WARNING  vocal isolation will NOT work in this app. The build is missing:\n${lines}\n  (add --require-isolation to make this an error)\n`);
}

console.log(`\nbuild-web: ${files} files, ${(bytes / 1024 / 1024).toFixed(2)} MB in ${path.relative(nativeDir, outDir)}/` + (removed.length ? ` (removed ${removed.join(', ')})` : ''));
console.log(`build-web: index.html references ${refs.length} local files, all present, none root-absolute.`);
console.log(`build-web: vocal isolation: ${iso.included ? 'included (' + iso.summary + ')' : 'NOT included (' + iso.summary + ')'}.`);
