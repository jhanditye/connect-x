// @vitest-environment jsdom
// A screen that throws while drawing must not blank the app: the shell shows a message, the tab bar stays, another tab still opens.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { installBrowserStubs } from './testing/trainerUi';
import { makeFakeTrainerController } from './testing/trainerFixtures';
import { setLeaveGuard } from './ui/leaveGuard';

vi.mock('./ui/pages/Guide', () => ({
  GuidePage: () => {
    throw new Error('Guide exploded');
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('App error boundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    installBrowserStubs();
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.location.hash = '#guide';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('keeps the tab bar and a way out when one screen throws, and recovers when another tab opens', async () => {
    await act(async () => root.render(<App trainerController={makeFakeTrainerController()} />));
    expect(container.querySelector('.app-error--page')).not.toBeNull();
    expect(container.querySelector('.app-error pre')?.textContent).toContain('Guide exploded');
    expect(container.querySelector('nav.tabbar')).not.toBeNull();
    const reload = Array.from(container.querySelectorAll('button')).find((b) => /Reload Mimic/.test(b.textContent ?? ''));
    expect(reload).toBeTruthy();

    // Tapping another tab recovers.
    await act(async () => {
      window.location.hash = '#settings';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('.app-error')).toBeNull();
    expect(container.querySelector('.page--settings')).not.toBeNull();
  });

  it('holds an in-app link back when a screen has a leave guard (a recording in progress), and follows it otherwise', async () => {
    window.location.hash = '#studio';
    await act(async () => root.render(<App trainerController={makeFakeTrainerController()} />));
    const asked: string[] = [];
    const remove = setLeaveGuard((href) => (asked.push(href), true));
    const progress = Array.from(container.querySelectorAll<HTMLAnchorElement>('.tabbar a')).find((a) => /Progress/.test(a.textContent ?? ''))!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => void progress.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(asked).toEqual(['#progress']);
    remove();
    const ev2 = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => void progress.dispatchEvent(ev2));
    expect(ev2.defaultPrevented).toBe(false);
  });
});
