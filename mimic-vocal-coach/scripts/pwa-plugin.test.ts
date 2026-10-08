import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPrecacheList, renderServiceWorker, versionOf } from './pwa-plugin.ts';

function fakeDist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mimic-dist-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('buildPrecacheList', () => {
  it('lists every file with "/" paths, skips sw.js and source maps, and marks hashed assets immutable', () => {
    const dir = fakeDist({
      'index.html': '<html></html>',
      'manifest.webmanifest': '{}',
      'sw.js': 'old worker',
      'assets/index-Cxh-_oUg.js': 'a',
      'assets/index-Cxh-_oUg.js.map': 'map',
      'assets/figtree-latin-D_ZTVpCC.woff2': 'f',
      'icons/icon-192.png': 'p',
    });
    const list = buildPrecacheList(dir);
    expect(list.map((e) => e.url)).toEqual(['assets/figtree-latin-D_ZTVpCC.woff2', 'assets/index-Cxh-_oUg.js', 'icons/icon-192.png', 'index.html', 'manifest.webmanifest']);
    expect(list.find((e) => e.url === 'assets/index-Cxh-_oUg.js')?.revision).toBeNull();
    expect(list.find((e) => e.url === 'index.html')?.revision).toMatch(/^[0-9a-f]{12}$/);
  });

  it('gives an unhashed file a new revision when its content changes', () => {
    const a = buildPrecacheList(fakeDist({ 'index.html': 'one' }));
    const b = buildPrecacheList(fakeDist({ 'index.html': 'two' }));
    expect(a[0].revision).not.toBe(b[0].revision);
  });
});

describe('versionOf', () => {
  const base = [
    { url: 'index.html', revision: 'aaaaaaaaaaaa' },
    { url: 'assets/app-AbCd1234.js', revision: null },
  ];
  it('is stable for the same files and changes when a file, a hashed name or a revision changes', () => {
    expect(versionOf(base)).toBe(versionOf(structuredClone(base)));
    expect(versionOf(base)).toMatch(/^[0-9a-f]{12}$/);
    expect(versionOf([{ ...base[0], revision: 'bbbbbbbbbbbb' }, base[1]])).not.toBe(versionOf(base));
    expect(versionOf([base[0], { url: 'assets/app-ZyXw9876.js', revision: null }])).not.toBe(versionOf(base));
    expect(versionOf([...base, { url: 'icons/x.png', revision: 'cccccccccccc' }])).not.toBe(versionOf(base));
  });
});

describe('renderServiceWorker', () => {
  const template = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');

  it('the template has each placeholder exactly once', () => {
    expect(template.match(/__MIMIC_VERSION__/g)).toHaveLength(1);
    expect(template.match(/__MIMIC_PRECACHE__/g)).toHaveLength(1);
  });

  it('inserts the version and the list literally (even with $ characters in a name)', () => {
    const entries = [{ url: 'assets/we$ird-AbCd1234.js', revision: null }, { url: 'index.html', revision: 'aaaaaaaaaaaa' }];
    const out = renderServiceWorker(template, entries);
    expect(out).toContain(`const VERSION = '${versionOf(entries)}';`);
    const list = out.match(/const PRECACHE = (\[.*\]);/)?.[1];
    expect(JSON.parse(list ?? '[]')).toEqual(entries);
    expect(out).not.toContain('__MIMIC_');
    // The generated worker must at least parse as JavaScript.
    expect(() => new Function(out)).not.toThrow();
  });
});
