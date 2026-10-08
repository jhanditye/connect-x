// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MORE_ROUTES, TAB_ROUTES, TOP_ROUTES, type Route } from '../../state/routing';
import { TabBar, TopBar } from './Nav';

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

function render(route: Route, resultsEnabled = true) {
  act(() =>
    root.render(
      <>
        <TopBar route={route} resultsEnabled={resultsEnabled} />
        <TabBar route={route} resultsEnabled={resultsEnabled} />
      </>,
    ),
  );
}
const tabs = () => Array.from(container.querySelectorAll('.tabbar a.nav-link'));
const top = () => Array.from(container.querySelectorAll('.topnav a.nav-link'));
const label = (a: Element) => a.textContent?.trim();

describe('Nav', () => {
  it('the phone bar has five tabs: Trainer, Studio, Results, Progress, More', () => {
    render('trainer');
    expect(tabs().map(label)).toEqual(['Trainer', 'Studio', 'Results', 'Progress', 'More']);
    expect(tabs().map((a) => a.getAttribute('href'))).toEqual(TAB_ROUTES.map((r) => `#${r}`));
    expect(container.querySelectorAll('.tabbar svg')).toHaveLength(5);
  });

  it('the desktop bar keeps every page except More', () => {
    render('studio');
    expect(top().map(label)).toEqual(['Trainer', 'Studio', 'Results', 'Practice', 'Progress', 'Guide', 'Settings']);
    expect(top().map((a) => a.getAttribute('href'))).toEqual(TOP_ROUTES.map((r) => `#${r}`));
  });

  it('marks the current page, and More stands for Practice, Guide and Settings on the phone bar', () => {
    render('trainer');
    expect(tabs().find((a) => a.getAttribute('aria-current') === 'page')?.textContent).toMatch(/Trainer/);
    for (const r of MORE_ROUTES) {
      render(r);
      expect(tabs().filter((a) => a.getAttribute('aria-current') === 'page').map(label)).toEqual(['More']);
      expect(top().filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href'))).toEqual([`#${r}`]);
    }
    render('more');
    expect(tabs().filter((a) => a.getAttribute('aria-current') === 'page').map(label)).toEqual(['More']);
  });

  it('Results is disabled with a reason until there is a take, in both bars', () => {
    render('trainer', false);
    for (const a of [...tabs(), ...top()].filter((x) => /Results/.test(x.textContent ?? ''))) {
      expect(a.getAttribute('aria-disabled')).toBe('true');
      expect(a.getAttribute('title')).toBe('Analyse a take first');
      expect(a.getAttribute('href')).toBeNull();
    }
    render('trainer', true);
    for (const a of [...tabs(), ...top()].filter((x) => /Results/.test(x.textContent ?? ''))) expect(a.getAttribute('href')).toBe('#results');
  });

  it('the wordmark goes to the Trainer', () => {
    render('guide');
    const w = container.querySelector('.wordmark');
    expect(w?.getAttribute('href')).toBe('#trainer');
    expect(w?.getAttribute('aria-label')).toMatch(/Trainer/);
  });

  it('both bars are landmarks with a name', () => {
    render('trainer');
    expect(Array.from(container.querySelectorAll('nav')).map((n) => n.getAttribute('aria-label'))).toEqual(['Main', 'Main']);
  });
});
