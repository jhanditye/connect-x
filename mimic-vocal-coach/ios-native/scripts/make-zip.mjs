// Zips this project for moving to a Mac, leaving out node_modules and every build output.
//
//   npm run zip                          -> out/ios-native.zip
//   npm run zip -- --out /some/where.zip
//   npm run zip -- --with-web            also include the web bundle that `cap sync` copied into ios/App/App/public
//
// Without --with-web the zip needs `npm install` and `npm run ios` on the Mac (which builds a fresh web bundle).
// With --with-web the Xcode project is complete as it stands, so you can open ios/App/App.xcodeproj without Node,
// but the web app inside is a snapshot: run `npm run prepare:ios` right before zipping so it is the current one.
// Uses the system `zip` command (present on macOS and most Linux).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectIsolation } from './lib/isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, '..');
const parent = path.dirname(nativeDir);
const folder = path.basename(nativeDir);

const args = process.argv.slice(2);
const withWeb = args.includes('--with-web');
const outIdx = args.indexOf('--out');
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1] ?? '' : path.join(nativeDir, 'out', 'ios-native.zip'));
if (outIdx >= 0 && !args[outIdx + 1]) {
  console.error('make-zip: --out needs a file name.');
  process.exit(1);
}
if (!fs.existsSync(path.join(nativeDir, 'ios', 'App', 'App.xcodeproj'))) {
  console.error('make-zip: the native project is missing (ios/). Run `npx cap add ios` first.');
  process.exit(1);
}
if (withWeb && !fs.existsSync(path.join(nativeDir, 'ios', 'App', 'App', 'public', 'index.html'))) {
  console.error('make-zip: --with-web needs a synced web bundle. Run `npm run prepare:ios` first.');
  process.exit(1);
}

if (withWeb) {
  // The zip carries whatever `cap sync` copied. The 20 MB vocal-isolation model is git-ignored, so a bundle made without it ships an app where the option never appears.
  const iso = inspectIsolation(path.join(nativeDir, 'ios', 'App', 'App', 'public'));
  if (iso.hasManifest && !iso.included) console.warn(`make-zip: WARNING  the web bundle inside the zip has no working vocal isolation (${iso.summary}).`);
}

const exclude = [
  `${folder}/node_modules/*`,
  `${folder}/www/*`,
  `${folder}/check-www/*`,
  `${folder}/out/*`,
  `${folder}/ios/App/Pods/*`,
  `${folder}/ios/App/build/*`,
  `${folder}/ios/App/output/*`,
  '*/DerivedData/*',
  '*/xcuserdata/*',
  '*.xcuserstate',
  '*.DS_Store',
  '*.zip',
  ...(withWeb ? [] : [`${folder}/ios/App/App/public/*`]),
];

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });
const r = spawnSync('zip', ['-r', '-X', '-q', out, folder, '-x', ...exclude], { cwd: parent, stdio: 'inherit' });
if (r.error || r.status !== 0) {
  console.error(`make-zip: zip failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}.`);
  process.exit(1);
}
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`make-zip: wrote ${out} (${kb} kB), ${withWeb ? 'with' : 'without'} the web bundle in ios/App/App/public.`);
