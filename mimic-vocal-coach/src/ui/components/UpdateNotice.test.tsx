// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PwaState } from '../../pwa/register';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: PwaState = { supported: true, offlineReady: true, updateReady: true, version: 'abc', updateDismissed: false, busy: false, updateQueued: false, updatedElsewhere: false };
let current: PwaState = BASE;
const applyUpdate = vi.fn();
const dismissUpdate = vi.fn();
const reloadForUpdate = vi.fn();
vi.mock('../../pwa/register', () => ({ usePwa: () => current, applyUpdate: () => applyUpdate(), dismissUpdate: () => dismissUpdate(), reloadForUpdate: () => reloadForUpdate() }));

import { UpdateNotice } from './UpdateNotice';

describe('UpdateNotice', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = (patch: Partial<PwaState> = {}) => {
    current = { ...BASE, ...patch };
    act(() => root.render(<UpdateNotice />));
  };
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    applyUpdate.mockClear();
    dismissUpdate.mockClear();
    reloadForUpdate.mockClear();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('is one slim row with Update and a way to hide it (not a tall sticky card)', () => {
    render();
    const bar = host.querySelector('.update-banner')!;
    expect(bar.textContent).toMatch(/New version ready/);
    expect(bar.querySelectorAll('p')).toHaveLength(1);
    expect(bar.textContent!.length).toBeLessThan(90);
    act(() => bar.querySelector<HTMLButtonElement>('button.button')!.click());
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    act(() => bar.querySelector<HTMLButtonElement>('button[aria-label="Hide until later"]')!.click());
    expect(dismissUpdate).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when there is no update or it was hidden', () => {
    render({ updateReady: false });
    expect(host.querySelector('.update-banner')).toBeNull();
    render({ updateDismissed: true });
    expect(host.querySelector('.update-banner')).toBeNull();
  });

  it('while a take is running it says the update waits, and keeps focus on the button once queued', () => {
    render({ busy: true });
    expect(host.textContent).toMatch(/Finish your take first/);
    render({ busy: true, updateQueued: true });
    const update = host.querySelector<HTMLButtonElement>('button.button')!;
    expect(update.textContent).toBe('Waiting…');
    expect(update.disabled).toBe(false);
    expect(update.getAttribute('aria-disabled')).toBe('true');
  });

  it('a tab updated from another tab offers a reload and never reloads itself', () => {
    render({ updatedElsewhere: true, updateReady: false });
    expect(host.textContent).toMatch(/updated in another tab/);
    act(() => host.querySelector<HTMLButtonElement>('button')!.click());
    expect(reloadForUpdate).toHaveBeenCalledTimes(1);
  });
});
