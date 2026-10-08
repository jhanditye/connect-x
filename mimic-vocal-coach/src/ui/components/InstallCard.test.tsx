// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformEnv } from '../../pwa/platform';
import { BrowserTabNote, InstallCard } from './InstallCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const INSTAGRAM = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 Instagram 380.0.0.28.104';
const env = (over: Partial<PlatformEnv> = {}): PlatformEnv => ({
  userAgent: SAFARI,
  platform: 'iPhone',
  maxTouchPoints: 5,
  standaloneFlag: false,
  displayModeStandalone: false,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('InstallCard', () => {
  it('shows the Add to Home Screen steps on iPhone Safari in a browser tab', () => {
    act(() => root.render(<InstallCard env={env()} />));
    expect(container.textContent).toContain('Install Mimic on your iPhone');
    expect(container.textContent).toContain('Add to Home Screen');
    expect(container.textContent).toContain('Open as Web App');
  });

  it('renders nothing once installed or off iOS', () => {
    act(() => root.render(<InstallCard env={env({ standaloneFlag: true })} />));
    expect(container.textContent).toBe('');
    act(() => root.render(<InstallCard env={env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', platform: 'Linux', maxTouchPoints: 0 })} />));
    expect(container.textContent).toBe('');
  });

  it('asks in-app browser users to open Safari first', () => {
    act(() => root.render(<InstallCard env={env({ userAgent: INSTAGRAM })} />));
    expect(container.textContent).toContain('Open in Safari');
    expect(container.textContent).not.toContain('Scroll down and tap');
  });

  it('can be dismissed and stays dismissed, except where it is persistent (Settings)', () => {
    act(() => root.render(<InstallCard env={env()} />));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label^="Hide"]')!.click());
    expect(container.textContent).toBe('');
    expect(store.get('mimic.installCard.dismissed')).toBe('1');
    act(() => root.render(<InstallCard key="again" env={env()} />));
    expect(container.textContent).toBe('');
    act(() => root.render(<InstallCard key="settings" env={env()} persistent />));
    expect(container.textContent).toContain('Install Mimic on your iPhone');
    expect(container.querySelector('button[aria-label^="Hide"]')).toBeNull();
  });

  it('hiding the card moves focus to the next heading, never to <body>', async () => {
    act(() =>
      root.render(
        <main className="main" tabIndex={-1}>
          <InstallCard env={env()} />
          <section>
            <h2 id="next-h">Today</h2>
          </section>
        </main>,
      ),
    );
    const hide = container.querySelector<HTMLButtonElement>('button[aria-label^="Hide"]')!;
    hide.focus();
    expect(document.activeElement).toBe(hide);
    await act(async () => {
      hide.click();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(container.querySelector('.install-card')).toBeNull();
    expect(document.activeElement?.id).toBe('next-h');
  });

  it('falls back to the page when nothing follows the card', async () => {
    act(() =>
      root.render(
        <main className="main" tabIndex={-1}>
          <InstallCard env={env()} />
        </main>,
      ),
    );
    const hide = container.querySelector<HTMLButtonElement>('button[aria-label^="Hide"]')!;
    hide.focus();
    await act(async () => {
      hide.click();
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(document.activeElement).toBe(container.querySelector('main'));
  });
});

describe('BrowserTabNote', () => {
  it('warns on an iPhone browser tab that clips saved here will not be in the Home Screen app', () => {
    act(() => root.render(<BrowserTabNote env={env()} />));
    expect(container.textContent).toMatch(/You are in a browser tab\. Clips saved here will not appear in the Home Screen app/);
  });

  it('says nothing in the installed app or off iOS', () => {
    act(() => root.render(<BrowserTabNote env={env({ standaloneFlag: true })} />));
    expect(container.textContent).toBe('');
    act(() => root.render(<BrowserTabNote env={env({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', platform: 'Linux', maxTouchPoints: 0 })} />));
    expect(container.textContent).toBe('');
  });
});
