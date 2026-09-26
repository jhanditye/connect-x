// @vitest-environment jsdom
// Integration test of the shell: real reducer, provider, storage, coach modules and charts. Only the
// analysis worker is replaced (by a fixture), so the flow is fast and deterministic.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInWorker } from './analysis/client';
import { App } from './App';
import { SINGERS } from './coach/profiles';
import { encodeWav } from './audio/wav';
import { loadSessions } from './storage/history';
import { makeFakeAnalysis } from './testing/fixtures';
import type { VoiceAnalysis } from './types';

vi.mock('./analysis/client', async () => {
  const { makeFakeAnalysis } = await import('./testing/fixtures');
  return {
    analyzeInWorker: vi.fn(async (_s: Float32Array, _r: number, opts: { voiceType: string }, onProgress?: (f: number) => void) => {
      onProgress?.(0.5);
      const a = makeFakeAnalysis();
      return { ...a, warnings: [`analysed as ${opts.voiceType}`] };
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // jsdom lacks these browser APIs; charts may use them for sizing and theming.
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
});

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(analyzeInWorker).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function buttonNamed(re: RegExp): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find((el) => re.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
}

async function clickAsync(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await tick();
}

async function runDemo() {
  await clickAsync(buttonNamed(/Try a demo take/));
  await tick(10);
}

async function goTo(route: string) {
  window.location.hash = `#${route}`;
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await tick();
}

async function uploadReference() {
  await clickAsync(buttonNamed(/Reference clip/));
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  const input = inputs[inputs.length - 1];
  const file = new File([encodeWav(new Float32Array(22050).fill(0.1), 22050)], 'isolated-vocal.wav', { type: 'audio/wav' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await tick(20);
}

function h1(): string {
  return container.querySelector('h1')?.textContent ?? '';
}

describe('App', () => {
  it('starts in the Studio with Results disabled', () => {
    act(() => root.render(<App />));
    expect(container.querySelector('h1')?.textContent).toMatch(/Sing a take/);
    const resultsLinks = Array.from(container.querySelectorAll('a.nav-link')).filter((a) => /Results/.test(a.textContent ?? ''));
    expect(resultsLinks.length).toBeGreaterThan(0);
    for (const a of resultsLinks) expect(a.getAttribute('aria-disabled')).toBe('true');
    expect(container.querySelectorAll('.singer-card')).toHaveLength(SINGERS.length + 1);
  });

  it('runs the demo take, shows results, and re-scores when switching singer without re-analysing', async () => {
    act(() => root.render(<App />));
    await runDemo();
    expect(analyzeInWorker).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe('#results');
    expect(container.querySelector('h1')?.textContent).toContain(`Your take vs ${SINGERS[0].name}`);
    expect(container.textContent).toContain('analysed as baritone');
    expect(container.querySelectorAll('.coach-card').length).toBeGreaterThan(0);

    await clickAsync(buttonNamed(new RegExp(SINGERS[1].name)));
    expect(container.querySelector('h1')?.textContent).toContain(`Your take vs ${SINGERS[1].name}`);
    expect(analyzeInWorker).toHaveBeenCalledTimes(1);
  });

  it('saves the result to progress once per singer, even after leaving Results and coming back', async () => {
    act(() => root.render(<App />));
    await runDemo();
    await clickAsync(buttonNamed(/Save to progress/));
    expect(loadSessions()).toHaveLength(1);
    expect(loadSessions()[0].profileId).toBe(SINGERS[0].id);
    expect(buttonNamed(/Saved to Progress/).getAttribute('aria-disabled')).toBe('true');
    await goTo('guide');
    await goTo('results');
    expect(buttonNamed(/Saved to Progress/).getAttribute('aria-disabled')).toBe('true');
    await clickAsync(buttonNamed(/Saved to Progress/));
    expect(loadSessions()).toHaveLength(1);
    // Another singer is a separate result.
    await clickAsync(buttonNamed(new RegExp(SINGERS[1].name)));
    await clickAsync(buttonNamed(/Save to progress/));
    expect(loadSessions()).toHaveLength(2);
  });

  it('shows "Not scored" and refuses to save a take with no measurable singing', async () => {
    const silent = (): VoiceAnalysis => {
      const a = makeFakeAnalysis();
      const style = Object.fromEntries(Object.keys(a.style).map((k) => [k, null])) as unknown as VoiceAnalysis['style'];
      return { ...a, voicedSec: 0, style, warnings: ['No clear singing was detected.'], issues: ['too-little-singing'] };
    };
    vi.mocked(analyzeInWorker).mockImplementationOnce(async () => silent());
    act(() => root.render(<App />));
    await runDemo();
    expect(container.querySelector('.not-scored')?.textContent).toContain('Not scored');
    await clickAsync(buttonNamed(/Save to progress/));
    expect(loadSessions()).toHaveLength(0);
  });

  it('compares with a reference clip after the result paints, and a settings change keeps the chosen singer', async () => {
    act(() => root.render(<App />));
    await uploadReference();
    // A usable clip becomes the target, based on the singer selected when it was loaded (Shawn).
    expect(container.querySelector('.singer-card--reference')?.getAttribute('aria-pressed')).toBe('true');
    await runDemo();
    expect(h1()).toContain('Your take vs isolated-vocal');
    expect(container.textContent).toContain('Against your reference clip');
    expect(container.textContent).not.toContain('NaN');
    await clickAsync(buttonNamed(new RegExp(SINGERS[1].name)));
    expect(h1()).toContain(`Your take vs ${SINGERS[1].name}`);

    await goTo('settings');
    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      select.value = 'tenor';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Take re-analysis, then reference re-analysis (each debounced).
    await tick(600);
    await tick(600);
    expect(analyzeInWorker).toHaveBeenCalledTimes(4);
    await goTo('results');
    expect(h1()).toContain(`Your take vs ${SINGERS[1].name}`);
    await goTo('studio');
    // The clip keeps the base it was loaded with (Shawn), not the singer selected when settings changed.
    await clickAsync(buttonNamed(/Use as target/));
    expect(container.textContent).toContain(`come from the ${SINGERS[0].name} profile`);
  });

  it('re-analyses the take when the voice type changes in Settings', async () => {
    act(() => root.render(<App />));
    await runDemo();
    window.location.hash = '#settings';
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    const select = container.querySelector<HTMLSelectElement>('select');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = 'tenor';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await tick(600);
    expect(analyzeInWorker).toHaveBeenCalledTimes(2);
    expect(vi.mocked(analyzeInWorker).mock.calls[1][2]).toMatchObject({ voiceType: 'tenor' });
  });

  it('clears all data after an in-page confirmation', async () => {
    act(() => root.render(<App />));
    await runDemo();
    await clickAsync(buttonNamed(/Save to progress/));
    window.location.hash = '#settings';
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await clickAsync(buttonNamed(/Clear all data/));
    expect(loadSessions()).toHaveLength(1);
    await clickAsync(buttonNamed(/Yes, delete everything/));
    expect(loadSessions()).toHaveLength(0);
    // Focus moves to the confirmation instead of falling to the page body.
    expect(document.activeElement?.textContent).toBe('All data cleared.');
    const resultsLink = Array.from(container.querySelectorAll('a.nav-link')).find((a) => /Results/.test(a.textContent ?? ''));
    expect(resultsLink?.getAttribute('aria-disabled')).toBe('true');
  });
});
