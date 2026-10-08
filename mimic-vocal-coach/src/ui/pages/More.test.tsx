// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MORE_ROUTES } from '../../state/routing';
import { MorePage } from './More';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<MorePage />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MorePage', () => {
  it('lists Practice, Guide and Settings as big links, each with a line saying what is in it', () => {
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.mo-link'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(MORE_ROUTES.map((r) => `#${r}`));
    expect(links.map((a) => a.querySelector('.mo-name')?.textContent)).toEqual(['Practice', 'Guide', 'Settings']);
    for (const a of links) expect((a.querySelector('.mo-about')?.textContent ?? '').length).toBeGreaterThan(40);
    expect(container.querySelector('h1')?.textContent).toBe('More from Mimic');
  });

  it('points to the device checks for a phone that misbehaves, and says clips stay on the device', () => {
    const diag = Array.from(container.querySelectorAll('a')).find((a) => /device checks/.test(a.textContent ?? ''));
    expect(diag?.getAttribute('href')).toBe('#settings/diagnostics');
    expect(container.textContent).toMatch(/clips, phrases and scores stay on this device/);
    expect(container.textContent).toMatch(/not affiliated with the artists/);
  });

  it('draws each icon as decoration', () => {
    expect(container.querySelectorAll('.mo-icon[aria-hidden="true"] svg')).toHaveLength(3);
  });
});
