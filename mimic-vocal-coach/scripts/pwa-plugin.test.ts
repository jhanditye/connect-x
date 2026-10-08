import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildOptInList, buildPrecacheList, renderServiceWorker, versionOf } from './pwa-plugin.ts';

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
    expect(template.match(/__MIMIC_OPTIN__/g)).toHaveLength(1);
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

describe('vocal isolation stays out of the offline precache', () => {
  const dist = {
    'index.html': '<html></html>',
    'assets/index-Cxh-_oUg.js': 'a',
    'assets/workerFactory-bGCchAyL.js': 'tiny',
    'assets/separator.worker-D1K1sp1p.js': 'worker',
    'assets/ort-wasm-simd-threaded-B92PF46Y.wasm': 'wasm',
    'assets/ort-wasm-simd-threaded-dCV5mLr0.mjs': 'loader',
    'models/vocal-isolation.onnx': 'model',
    'models/vocal-isolation.json': '{}',
    'models/README.md': 'readme',
  };

  it('leaves out the model, its manifest, the runtime\'s wasm and loader and the worker, and keeps everything else', () => {
    const list = buildPrecacheList(fakeDist(dist)).map((e) => e.url);
    expect(list).toEqual(['assets/index-Cxh-_oUg.js', 'assets/workerFactory-bGCchAyL.js', 'index.html']);
  });

  it('lists the runtime files (not the model) as opt-in, for the service worker to keep in a cache of their own', () => {
    expect(buildOptInList(fakeDist(dist))).toEqual(['assets/ort-wasm-simd-threaded-B92PF46Y.wasm', 'assets/ort-wasm-simd-threaded-dCV5mLr0.mjs', 'assets/separator.worker-D1K1sp1p.js']);
  });

  const template = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');
  const SCOPE = 'https://example.test/app/';
  const OPT = ['assets/ort-wasm-simd-threaded-AAAAAAAA.wasm'];

  function sandbox(optIn: string[]) {
    const stores = new Map<string, Map<string, Response>>();
    const handlers: Record<string, (e: unknown) => void> = {};
    const net = { calls: [] as string[] };
    const keyOf = (r: Request | string) => (typeof r === 'string' ? r : r.url);
    const cacheApi = (name: string) => ({
      match: async (r: Request | string) => stores.get(name)?.get(keyOf(r))?.clone(),
      put: async (r: Request | string, res: Response) => void (stores.get(name) ?? stores.set(name, new Map()).get(name))!.set(keyOf(r), res),
      delete: async (r: Request | string) => stores.get(name)?.delete(keyOf(r)) ?? false,
      keys: async () => [...(stores.get(name)?.keys() ?? [])].map((url) => ({ url })),
    });
    const caches = {
      open: async (name: string) => (stores.has(name) || stores.set(name, new Map()), cacheApi(name)),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    };
    const fetchFn = async (r: Request | string) => {
      net.calls.push(keyOf(r));
      const res = new Response('network ' + keyOf(r), { status: 200 });
      Object.defineProperty(res, 'type', { value: 'basic' });
      return res;
    };
    const self = { registration: { scope: SCOPE }, location: new URL(SCOPE), addEventListener: (t: string, fn: (e: unknown) => void) => void (handlers[t] = fn), clients: { claim: async () => {} }, skipWaiting: () => {} };
    runInNewContext(renderServiceWorker(template, [{ url: 'index.html', revision: 'aaaaaaaaaaaa' }], optIn), { self, caches, fetch: fetchFn, Request, Response, URL, Promise });
    const ask = async (url: string): Promise<Response | undefined> => {
      let out: Promise<Response> | undefined;
      handlers.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith: (p: Promise<Response>) => (out = p) });
      return out;
    };
    return { stores, handlers, net, ask, caches };
  }

  it('puts the opt-in list in the generated worker', () => {
    expect(renderServiceWorker(template, [], OPT)).toContain(`const OPT_IN = ${JSON.stringify(OPT)};`);
  });

  it('leaves the model alone: the page downloads, checks and keeps it, so the worker neither intercepts nor caches it', async () => {
    const sw = sandbox(OPT);
    expect(await sw.ask(SCOPE + 'models/vocal-isolation.onnx')).toBeUndefined();
    expect(await sw.ask(SCOPE + 'models/vocal-isolation.json')).toBeUndefined();
    expect(sw.net.calls).toEqual([]);
    expect([...sw.stores.keys()]).toEqual([]);
  });

  it('fetches an opt-in file once, keeps it in its own cache, and serves it from there afterwards', async () => {
    const sw = sandbox(OPT);
    const url = SCOPE + OPT[0];
    expect(await (await sw.ask(url))?.text()).toBe('network ' + url);
    expect(await (await sw.ask(url))?.text()).toBe('network ' + url);
    expect(sw.net.calls).toEqual([url]);
    expect([...sw.stores.keys()]).toEqual(['mimic-optin-v1']);
    expect([...sw.stores.keys()].some((k) => k.startsWith('mimic-precache-'))).toBe(false);
  });

  it('an update keeps the opt-in files that are still current, drops the ones of an older build, and clears old precaches', async () => {
    const sw = sandbox(OPT);
    const cache = await sw.caches.open('mimic-optin-v1');
    const old = new Response('old');
    await cache.put(SCOPE + 'assets/ort-wasm-simd-threaded-OLDOLDOL.wasm', old);
    await cache.put(SCOPE + OPT[0], new Response('current'));
    await sw.caches.open('mimic-precache-previous');
    await new Promise<void>((resolve) => sw.handlers.activate({ waitUntil: (p: Promise<void>) => void p.then(resolve) }));
    const left = [...(sw.stores.get('mimic-optin-v1')?.keys() ?? [])];
    expect(left).toEqual([SCOPE + OPT[0]]);
    expect([...sw.stores.keys()]).not.toContain('mimic-precache-previous');
  });
});
