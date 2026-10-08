// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// startPwa guards, in order: a service worker exists, the build is production, the page is a secure context. Inside the
// Capacitor app none of that matters: the app bundles the web build and a worker would only pin an old copy.

async function freshRegister() {
  vi.resetModules();
  return import('./register');
}

describe('startPwa inside the Capacitor app', () => {
  const register = vi.fn(() => Promise.reject(new Error('should not be called')));

  beforeEach(() => {
    register.mockClear();
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    vi.stubGlobal('isSecureContext', true);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register, addEventListener: vi.fn(), controller: null, ready: new Promise(() => undefined) },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('does not register a service worker, and says offline is not a worker feature there', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const { startPwa, getPwaState } = await freshRegister();
    startPwa();
    expect(register).not.toHaveBeenCalled();
    expect(getPwaState()).toMatchObject({ supported: false, offlineReady: false, updateReady: false });
  });

  it('control: in a normal production browser it does register', async () => {
    register.mockImplementation(() => new Promise(() => undefined) as never);
    const { startPwa, getPwaState } = await freshRegister();
    startPwa();
    expect(register).toHaveBeenCalledTimes(1);
    expect(getPwaState().supported).toBe(true);
  });
});
