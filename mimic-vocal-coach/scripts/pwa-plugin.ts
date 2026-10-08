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
    .filter(({ url }) => !SKIP.test(url))
    .map(({ file, url }) => ({
      url,
      revision: HASHED_ASSET.test(url) ? null : createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12),
    }));
}

export function versionOf(entries: PrecacheEntry[]): string {
  const h = createHash('sha256');
  // Hashed assets contribute their file name (which contains the hash); the rest contribute their digest.
  for (const e of entries) h.update(`${e.url}\u0000${e.revision ?? ''}\u0000`);
  return h.digest('hex').slice(0, 12);
}

export function renderServiceWorker(template: string, entries: PrecacheEntry[]): string {
  const version = versionOf(entries);
  // Function replacers: the JSON must be inserted literally ($ sequences in a string replacement are special).
  return template.replace('__MIMIC_VERSION__', () => version).replace('__MIMIC_PRECACHE__', () => JSON.stringify(entries));
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
      writeFileSync(join(outDir, 'sw.js'), renderServiceWorker(readFileSync(templatePath, 'utf8'), entries));
      config.logger.info(`pwa-precache: sw.js written, ${entries.length} files, version ${versionOf(entries)}`);
    },
  };
}
