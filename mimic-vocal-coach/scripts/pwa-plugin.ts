// Vite plugin: writes dist/sw.js after the build, with a precache manifest of every emitted file.
//
// - No dependencies beyond node:*. The service worker source is scripts/sw.template.js; this plugin
//   replaces two placeholders in it (version + file list) and writes the result next to index.html.
// - Files under assets/ carry a content hash in their names (Vite's default), so their revision is
//   "immutable" (null): a new service worker copies them from the previous cache instead of
//   downloading them again. Everything else (index.html, manifest, icons) gets a sha256 revision and
//   is always re-fetched with cache: 'reload'.
// - The cache name contains VERSION = hash of (url + revision) of every file, so any change to any
//   file produces a new service worker and a new cache; old caches are deleted on activate.
// - Paths are relative to the service worker's scope, so the same build works at
//   https://<user>.github.io/<repo>/ and at a domain root (Vite `base: './'`).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export interface PrecacheEntry {
  /** Path relative to the service worker scope, using "/" separators. */
  url: string;
  /** sha256 prefix, or null when the file name already contains a content hash (immutable). */
  revision: string | null;
}

const SKIP = /(^|\/)(sw\.js|\.DS_Store|.*\.map)$/;
// Vocal isolation (src/audio/separation) is opt-in and big: the model (models/), the runtime's WebAssembly file and loader (assets/ort-*)
// and the worker that runs them (assets/separator.worker-*) are NOT in the offline precache, so an install stays small and an app
// update does not re-download them. The page keeps the model in its own Cache Storage cache; the service worker keeps the other
// three in a cache of their own (sw.template.js, "opt-in"), fetched the first time the feature is used.
export const OPT_IN_FILE = /^(models\/|assets\/(ort-[^/]*\.(wasm|mjs)|separator\.worker-[^/]*\.js)$)/;
// Vite names hashed assets like name-Cxh-_oUg.js; the hash is 8 chars of base64url.
const HASHED_ASSET = /^assets\/.+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function buildPrecacheList(outDir: string): PrecacheEntry[] {
  return walk(outDir)
    .map((file) => ({ file, url: relative(outDir, file).split(sep).join('/') }))
    .filter(({ url }) => !SKIP.test(url) && !OPT_IN_FILE.test(url))
    .map(({ file, url }) => ({
      url,
      revision: HASHED_ASSET.test(url) ? null : createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12),
    }));
}

/** The opt-in files the build emitted (not precached; the service worker keeps them in their own cache). The model is not among them. */
export function buildOptInList(outDir: string): string[] {
  return walk(outDir)
    .map((file) => relative(outDir, file).split(sep).join('/'))
    .filter((url) => !SKIP.test(url) && OPT_IN_FILE.test(url) && !url.startsWith('models/'));
}

export function versionOf(entries: PrecacheEntry[]): string {
  const h = createHash('sha256');
  // Hashed assets contribute their file name (which contains the hash); the rest contribute their digest.
  for (const e of entries) h.update(`${e.url}\u0000${e.revision ?? ''}\u0000`);
  return h.digest('hex').slice(0, 12);
}

export function renderServiceWorker(template: string, entries: PrecacheEntry[], optIn: string[] = []): string {
  const version = versionOf(entries);
  // Function replacers: the JSON must be inserted literally ($ sequences in a string replacement are special).
  return template
    .replace('__MIMIC_VERSION__', () => version)
    .replace('__MIMIC_PRECACHE__', () => JSON.stringify(entries))
    .replace('__MIMIC_OPTIN__', () => JSON.stringify(optIn));
}

export function pwaPrecache(options: { template?: string } = {}): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'mimic-pwa-precache',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
    },
    writeBundle(output) {
      const outDir = output.dir ?? join(config.root, config.build.outDir);
      const templatePath = options.template ?? join(config.root, 'scripts', 'sw.template.js');
      const entries = buildPrecacheList(outDir);
      if (!entries.some((e) => e.url === 'index.html')) throw new Error('pwa-precache: index.html missing from the build output');
      const optIn = buildOptInList(outDir);
      writeFileSync(join(outDir, 'sw.js'), renderServiceWorker(readFileSync(templatePath, 'utf8'), entries, optIn));
      config.logger.info(`pwa-precache: sw.js written, ${entries.length} files, version ${versionOf(entries)}, ${optIn.length} opt-in files kept out of the precache`);
    },
  };
}
