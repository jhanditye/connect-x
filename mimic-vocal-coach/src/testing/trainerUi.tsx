// Helpers for the jsdom tests of the Trainer screens: browser stubs, a mounted screen wrapped in the real AppProvider and a fake
// Trainer controller, and small queries. Test-only (imported by *.test.tsx files, never by the app).

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';
import { AppProvider } from '../state/AppProvider';
import { TrainerContext } from '../state/trainerContext';
import { makeFakeTrainerController, type FakeTrainerController } from './trainerFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Browser APIs jsdom lacks and the screens use for sizing, theming and scrolling. Safe to call more than once. */
export function installBrowserStubs(): void {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  if (!window.matchMedia) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  }
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
}

export const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

export interface TestScreen {
  readonly container: HTMLDivElement;
  /** The controller of the last mount. */
  controller: FakeTrainerController;
  /** Renders `node` inside the real AppProvider and the Trainer context. Pass a controller to use your own. */
  mount(node: ReactNode, controller?: FakeTrainerController): FakeTrainerController;
  unmount(): void;
  /** Moves the URL hash and tells the app (as a click on a link would). */
  go(hash: string): Promise<void>;
  q<T extends Element = HTMLElement>(selector: string): T;
  qa<T extends Element = HTMLElement>(selector: string): T[];
  has(selector: string): boolean;
  button(name: RegExp | string): HTMLButtonElement;
  hasButton(name: RegExp | string): boolean;
  link(name: RegExp | string): HTMLAnchorElement;
  click(el: Element): void;
  clickAsync(el: Element): Promise<void>;
  /** Everything the screen says, as one string. */
  text(): string;
}

const nameOf = (el: Element): string => `${(el.textContent ?? '').trim()} ${el.getAttribute('aria-label') ?? ''}`.trim();
const matches = (el: Element, name: RegExp | string): boolean => (typeof name === 'string' ? nameOf(el).includes(name) : name.test(nameOf(el)));

/** Registers beforeEach / afterEach that give each test a fresh container, hash and local storage, and returns the screen. */
export function useScreen(): TestScreen {
  let root: Root | null = null;
  const screen: TestScreen = {
    container: document.createElement('div'),
    controller: makeFakeTrainerController(),
    mount(node, controller) {
      const ctl = controller ?? makeFakeTrainerController();
      screen.controller = ctl;
      if (!root) root = createRoot(screen.container);
      act(() => {
        root?.render(
          <AppProvider>
            <TrainerContext.Provider value={ctl}>{node}</TrainerContext.Provider>
          </AppProvider>,
        );
      });
      return ctl;
    },
    unmount() {
      if (root) act(() => root?.unmount());
      root = null;
    },
    async go(hash) {
      window.location.hash = hash;
      await act(async () => {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      await tick();
    },
    q<T extends Element = HTMLElement>(selector: string): T {
      const el = screen.container.querySelector<T>(selector);
      if (!el) throw new Error(`Nothing matches ${selector}`);
      return el;
    },
    qa<T extends Element = HTMLElement>(selector: string): T[] {
      return Array.from(screen.container.querySelectorAll<T>(selector));
    },
    has: (selector) => screen.container.querySelector(selector) !== null,
    button(name) {
      const b = screen.qa<HTMLButtonElement>('button').find((el) => matches(el, name));
      if (!b) throw new Error(`No button matching ${String(name)}`);
      return b;
    },
    hasButton: (name) => screen.qa<HTMLButtonElement>('button').some((el) => matches(el, name)),
    link(name) {
      const a = screen.qa<HTMLAnchorElement>('a').find((el) => matches(el, name));
      if (!a) throw new Error(`No link matching ${String(name)}`);
      return a;
    },
    click: (el) => act(() => (el as HTMLElement).click()),
    clickAsync: async (el) => {
      await act(async () => (el as HTMLElement).click());
      await tick();
    },
    text: () => screen.container.textContent ?? '',
  };

  beforeEach(() => {
    installBrowserStubs();
    localStorage.clear();
    window.location.hash = '';
    screen.container.remove();
    (screen as { container: HTMLDivElement }).container = document.createElement('div');
    document.body.appendChild(screen.container);
    root = null;
  });
  afterEach(() => {
    screen.unmount();
    screen.container.remove();
    document.querySelectorAll('.imp-host').forEach((el) => el.remove());
    document.documentElement.classList.remove('imp-open');
    vi.restoreAllMocks();
  });
  return screen;
}
