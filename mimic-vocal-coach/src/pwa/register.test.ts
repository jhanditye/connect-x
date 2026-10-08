// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The update flow: only the tab where the person pressed Update is reloaded, and never while it is recording or analysing.

type Register = typeof import('./register');

class FakeContainer extends EventTarget {
  controller: object | null = {};
  ready = new Promise(() => undefined);
  postMessage = vi.fn();
  waiting = { postMessage: vi.fn(), state: 'installed', addEventListener: vi.fn() };
  register = vi.fn(async () => ({
    waiting: this.waiting,
    active: {},
    installing: null,
    addEventListener: vi.fn(),
    update: vi.fn(async () => undefined),
  }));
}

describe('service worker update flow', () => {
  let sw: FakeContainer;
  let reload: ReturnType<typeof vi.fn>;
  let reg: Register;

  async function start(controller: object | null = {}): Promise<void> {
    vi.resetModules();
    sw = new FakeContainer();
    sw.controller = controller;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
    reg = await import('./register');
    reg.startPwa();
    await vi.waitFor(() => expect(sw.register).toHaveBeenCalled());
    await vi.waitFor(() => expect(reg.getPwaState().updateReady || controller === null).toBe(true));
  }

  beforeEach(() => {
    reload = vi.fn();
    vi.stubEnv('PROD', true);
    vi.stubEnv('MODE', 'production');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('location', { href: 'http://localhost/', reload });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('Update now activates the waiting worker and reloads this tab once it takes over', async () => {
    await start();
    expect(reg.getPwaState().updateReady).toBe(true);
    reg.applyUpdate();
    expect(sw.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a tab that did not ask for the update is not reloaded when another tab applied it, and says so', async () => {
    await start();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    const s = reg.getPwaState();
    expect(s.updatedElsewhere).toBe(true);
    expect(s.updateReady).toBe(false);
    // The person can still reload it on purpose.
    reg.reloadForUpdate();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the first install taking control is not an update', async () => {
    await start(null);
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    expect(reg.getPwaState().updatedElsewhere).toBe(false);
  });

  it('Update now while a take is running waits, then applies when the take is done', async () => {
    await start();
    const done = reg.markBusy();
    expect(reg.getPwaState().busy).toBe(true);
    reg.applyUpdate();
    expect(sw.waiting.postMessage).not.toHaveBeenCalled();
    expect(reg.getPwaState().updateQueued).toBe(true);
    done();
    expect(reg.getPwaState().busy).toBe(false);
    expect(sw.waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reg.getPwaState().updateQueued).toBe(false);
  });

  it('a take that starts after Update was pressed holds the reload until it ends', async () => {
    await start();
    reg.applyUpdate();
    const done = reg.markBusy();
    sw.dispatchEvent(new Event('controllerchange'));
    expect(reload).not.toHaveBeenCalled();
    done();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a tab updated from elsewhere that is mid-take reloads only after the take, and only when asked', async () => {
    await start();
    sw.dispatchEvent(new Event('controllerchange'));
    const done = reg.markBusy();
    reg.reloadForUpdate();
    expect(reload).not.toHaveBeenCalled();
    done();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('hiding the bar lasts until the next check', async () => {
    await start();
    reg.dismissUpdate();
    expect(reg.getPwaState().updateDismissed).toBe(true);
    await reg.checkForUpdate();
    expect(reg.getPwaState().updateDismissed).toBe(false);
  });
});
