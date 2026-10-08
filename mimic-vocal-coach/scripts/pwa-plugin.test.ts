import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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

describe('the generated worker at run time', () => {
  const template = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');
  const entries = [{ url: 'index.html', revision: 'aaaaaaaaaaaa' }];
  const SCOPE = 'https://example.test/app/';

  /** Runs the worker in a sandbox with an in-memory Cache Storage and a network that can be switched off. */
  function sandbox() {
    const stores = new Map<string, Map<string, Response>>();
    const handlers: Record<string, (e: unknown) => void> = {};
    const net = { up: true, calls: [] as string[] };
    const key = (r: Request | string) => (typeof r === 'string' ? r : r.url);
    const cacheApi = (name: string) => ({
      match: async (r: Request | string) => stores.get(name)?.get(key(r))?.clone(),
      put: async (r: Request | string, res: Response) => void (stores.get(name) ?? stores.set(name, new Map()).get(name))!.set(key(r), res),
      keys: async () => [...(stores.get(name)?.keys() ?? [])],
    });
    const caches = {
      open: async (name: string) => (stores.has(name) || stores.set(name, new Map()), cacheApi(name)),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    };
    const fetchFn = async (r: Request | string) => {
      net.calls.push(key(r));
      if (!net.up) throw new TypeError('offline');
      const res = new Response('body of ' + key(r), { status: 200 });
      Object.defineProperty(res, 'type', { value: 'basic' }); // what a same-origin fetch returns
      return res;
    };
    const self = { registration: { scope: SCOPE }, location: new URL(SCOPE), addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn), clients: { claim: async () => {} }, skipWaiting: () => {} };
    runInNewContext(renderServiceWorker(template, entries), { self, caches, fetch: fetchFn, Request, Response, URL, Promise });
    const ask = async (request: { url: string; method: string; mode: string }): Promise<Response | undefined> => {
      let out: Promise<Response> | undefined;
      handlers.fetch({ request, respondWith: (p: Promise<Response>) => (out = p) });
      return out;
    };
    return { stores, handlers, net, ask, caches };
  }

  it('serves a missing file from the network and puts it back in the cache, so the next offline start works', async () => {
    const sw = sandbox();
    await new Promise<void>((resolve) => sw.handlers.install({ waitUntil: (p: Promise<void>) => void p.then(resolve) }));
    const [cacheName] = [...sw.stores.keys()];
    expect([...sw.stores.get(cacheName)!.keys()]).toEqual([SCOPE + 'index.html']);
    // iOS (or the user) emptied the cache while the worker stayed registered.
    await sw.caches.delete(cacheName);
    const nav = await sw.ask({ url: SCOPE + '#trainer', method: 'GET', mode: 'navigate' });
    expect(await nav?.text()).toContain('index.html');
    const asset = await sw.ask({ url: SCOPE + 'assets/app-AbCd1234.js', method: 'GET', mode: 'no-cors' });
    expect(await asset?.text()).toContain('app-AbCd1234.js');
    sw.net.up = false;
    const shell = await sw.ask({ url: SCOPE, method: 'GET', mode: 'navigate' });
    expect(await shell?.text()).toContain('index.html');
    const again = await sw.ask({ url: SCOPE + 'assets/app-AbCd1234.js', method: 'GET', mode: 'no-cors' });
    expect(await again?.text()).toContain('app-AbCd1234.js');
  });

  it('leaves other origins, other projects and POSTs alone', async () => {
    const sw = sandbox();
    await sw.caches.open('x');
    expect(await sw.ask({ url: 'https://api.anthropic.com/v1', method: 'GET', mode: 'cors' })).toBeUndefined();
    expect(await sw.ask({ url: SCOPE + 'x', method: 'POST', mode: 'cors' })).toBeUndefined();
    expect(await sw.ask({ url: 'https://example.test/other/', method: 'GET', mode: 'navigate' })).toBeUndefined();
  });
});
