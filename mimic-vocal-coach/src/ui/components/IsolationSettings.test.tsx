// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeparationAvailability } from '../../audio/separation/client';
import { MODEL_CACHE_NAME, type ModelCacheDeps } from '../../audio/separation/modelCache';
import { IsolationSettings } from './IsolationSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const MANIFEST = { name: 'Fake', version: '2', bytes: 20 * 1024 * 1024, sha256: 'a'.repeat(64), licence: 'MIT', source: 't', inputRate: 44100 };
const avail = (over: Partial<SeparationAvailability> = {}): SeparationAvailability => ({ available: true, reason: null, manifest: MANIFEST, modelKept: false, ...over });

/** Cache Storage with (or without) a kept model. */
function deps(kept: boolean) {
  const store = new Map<string, Response>();
  if (kept) {
    store.set('https://x.test/models/vocal-isolation.onnx', new Response('m'));
    store.set('https://x.test/models/vocal-isolation.json', new Response(JSON.stringify(MANIFEST)));
  }
  let exists = kept;
  const cache = { match: async (u: RequestInfo | URL) => store.get(String(u))?.clone() };
  const d: ModelCacheDeps = {
    fetch: vi.fn() as unknown as ModelCacheDeps['fetch'],
    caches: {
      open: async (name: string) => (name === MODEL_CACHE_NAME ? (cache as unknown as Cache) : (undefined as unknown as Cache)),
      has: async () => exists,
      delete: async () => ((exists = false), store.clear(), true),
    },
    sha256Hex: async () => '',
    resolve: (p) => 'https://x.test/' + p,
    sleep: async () => undefined,
  };
  return d;
}

const mount = async (props: Parameters<typeof IsolationSettings>[0]) => act(async () => root.render(<IsolationSettings {...props} />));

describe('IsolationSettings', () => {
  it('shows nothing where isolation cannot be used and nothing is on the phone', async () => {
    await mount({ check: async () => ({ available: false, reason: 'no-manifest', manifest: null, modelKept: false }), deps: deps(false) });
    expect(container.textContent).toBe('');
  });

  it('says the model is not downloaded yet, with its size, when this site offers it', async () => {
    await mount({ check: async () => avail(), deps: deps(false) });
    expect(container.textContent).toMatch(/Vocal isolation \(optional\)/);
    expect(container.textContent).toMatch(/Not downloaded/);
    expect(container.textContent).toMatch(/20 MB/);
    expect(container.querySelector('button')?.textContent ?? '').not.toMatch(/Remove/);
  });

  it('shows what is kept (name, version, size) and removes it on request', async () => {
    const d = deps(true);
    await mount({ check: async () => avail({ modelKept: true }), deps: d });
    expect(container.textContent).toMatch(/Downloaded/);
    expect(container.textContent).toMatch(/Fake, 2, 20 MB/);
    const button = Array.from(container.querySelectorAll('button')).find((b) => /Remove the model and engine/.test(b.textContent ?? ''));
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    expect(container.textContent).toMatch(/The model and the engine were removed from this phone/);
    expect(container.textContent).toMatch(/Not downloaded/);
  });

  it('keeps the Spleeter notice and licence one tap away', async () => {
    await mount({ check: async () => avail(), deps: deps(false) });
    expect(container.querySelector('details summary')?.textContent).toMatch(/About the model and its licence/);
    expect(container.querySelector('pre')?.textContent).toMatch(/Copyright \(c\) 2019-present, Deezer SA\./);
    expect(container.textContent).toMatch(/MIT-licensed/);
  });

  it('is offered when the model is on the phone even if this site no longer serves it (so it can be removed)', async () => {
    await mount({ check: async () => ({ available: false, reason: 'no-model', manifest: MANIFEST, modelKept: false }), deps: deps(true) });
    expect(container.textContent).toMatch(/Downloaded/);
  });
  it('in the native app the model is part of the app: no download wording and nothing to remove', async () => {
    await mount({ check: async () => avail({ modelKept: true }), deps: { ...deps(false), native: true } });
    expect(container.textContent).toMatch(/Included in the app/);
    expect(container.textContent).not.toMatch(/Not downloaded/);
    expect(Array.from(container.querySelectorAll('button')).some((b) => /Remove/.test(b.textContent ?? ''))).toBe(false);
  });
});
