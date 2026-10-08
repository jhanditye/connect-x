// @vitest-environment jsdom
// The Trainer inside the real shell: the five-tab phone bar, the default route, deep links, and the three cross-links into the
// older pages (Studio, Results, Settings). The library is the fake controller; only the analysis worker is replaced.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeInWorker } from './analysis/client';
import { App } from './App';
import { encodeWav } from './audio/wav';
import { makeFakeClip, makeFakeTrainerController, type FakeTrainerController } from './testing/trainerFixtures';
import { clearPendingImport, peekPendingImport } from './ui/trainerHandoff';

vi.mock('./analysis/client', async () => {
  const { makeFakeAnalysis } = await import('./testing/fixtures');
  return { analyzeInWorker: vi.fn(async () => makeFakeAnalysis()) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
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
  clearPendingImport();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(analyzeInWorker).mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('.imp-host').forEach((el) => el.remove());
  document.documentElement.classList.remove('imp-open');
});

const tick = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const render = (ctl: FakeTrainerController = makeFakeTrainerController()) => {
  act(() => root.render(<App trainerController={ctl} />));
  return ctl;
};
const buttonNamed = (re: RegExp): HTMLButtonElement => {
  const b = Array.from(container.querySelectorAll('button')).find((el) => re.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
};
const clickAsync = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await tick();
};
async function goTo(hash: string) {
  window.location.hash = hash;
  await act(async () => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await tick();
}
const h1 = () => container.querySelector('h1')?.textContent ?? '';
const tabs = () => Array.from(container.querySelectorAll('.tabbar a.nav-link')).map((a) => a.textContent?.trim());

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

describe('App with the Trainer', () => {
  it('opens on the Trainer library, with five tabs on the phone bar and the skip link pointing there', () => {
    render();
    expect(h1()).toBe('Practise with the voices you love');
    // Results is a real link before the first Studio take (its page explains); screen readers are told there is no take yet.
    expect(tabs()).toEqual(['Trainer', 'Studio', 'Results (no take yet)', 'Progress', 'More']);
    expect(container.querySelector('.tabbar a[aria-current="page"]')?.textContent).toMatch(/Trainer/);
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#trainer');
    expect(document.title).toBe('Trainer · Mimic Vocal Coach');
  });

  it('the More tab leads to Practice, Guide and Settings, and stays current on them', async () => {
    render();
    await goTo('#more');
    expect(h1()).toBe('More from Mimic');
    const links = Array.from(container.querySelectorAll('a.mo-link')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#practice', '#guide', '#settings']);
    await goTo('#guide');
    expect(h1()).toMatch(/How Mimic listens/);
    expect(container.querySelector('.tabbar a[aria-current="page"]')?.textContent).toMatch(/More/);
    expect(container.querySelector('.topnav a[aria-current="page"]')?.textContent).toMatch(/Guide/);
  });

  it('the desktop bar lists every page, and the wordmark goes to the Trainer', () => {
    render();
    expect(Array.from(container.querySelectorAll('.topnav a.nav-link')).map((a) => a.textContent?.trim())).toEqual(['Trainer', 'Studio', 'Results (no take yet)', 'Practice', 'Progress', 'Guide', 'Settings']);
    expect(container.querySelector('.wordmark')?.getAttribute('href')).toBe('#trainer');
  });

  it('deep links open a clip and a phrase, and the browser title follows the page', async () => {
    const ctl = render();
    await goTo('#trainer/c/fake-clip');
    expect(h1()).toBe('Fake clip, 12 phrases');
    await goTo('#trainer/c/fake-clip/p/3');
    expect(container.querySelector('h1')?.textContent).toBe('Phrase 3 of 12');
    expect(ctl.engines).toHaveLength(1);
    await goTo('#trainer');
    expect(h1()).toBe('Practise with the voices you love');
    expect(ctl.engines[0].calls).toContain('dispose');
  });

  it('an empty library shows both ways forward: Add clips, and a free take in the Studio', () => {
    render(makeFakeTrainerController({ clips: [] }));
    expect(container.querySelector('.te')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.getAttribute('href') === '#studio')).toBe(true);
  });
});

describe('The Trainer in the Studio and Results', () => {
  it('the Studio\'s singer panel invites you to add clips to the Trainer and lists the singer\'s clips', async () => {
    render();
    await goTo('#studio');
    expect(container.querySelector('#measure-heading')?.textContent).toBe('Add clips to the Trainer');
    expect(container.querySelector('.measure a.button--accent')?.getAttribute('href')).toBe('#trainer/add');
    expect(container.querySelector('.mt-clip-name')?.textContent).toBe('Fake clip, 12 phrases');
  });

  it('a reference clip can be opened in the Trainer without picking the file again', async () => {
    render();
    await goTo('#studio');
    await uploadReference();
    await clickAsync(buttonNamed(/Open in Trainer/));
    expect(window.location.hash).toBe('#trainer/add');
    const [file] = peekPendingImport();
    expect(file.name).toBe('isolated-vocal.wav');
    expect(file.type).toBe('audio/wav');
  });

  it('a reference clip that is already in the library opens that clip', async () => {
    render(makeFakeTrainerController({ clips: [makeFakeClip({ id: 'iv', title: 'isolated-vocal' })] }));
    await goTo('#studio');
    await uploadReference();
    const link = Array.from(container.querySelectorAll('a')).find((a) => /Open in Trainer/.test(a.textContent ?? ''));
    expect(link?.getAttribute('href')).toBe('#trainer/c/iv');
  });

  it('Results offers "Practise this phrase by phrase" when a reference clip is loaded, and it opens the add sheet with that clip', async () => {
    const ctl = render();
    await goTo('#studio');
    await uploadReference();
    await clickAsync(buttonNamed(/Try a demo take/));
    await tick(10);
    expect(window.location.hash).toBe('#results');
    const practise = buttonNamed(/Practise this phrase by phrase/);
    expect(container.querySelector('.ref-trainer .field-hint')?.textContent).toMatch(/stays on this device/);
    await clickAsync(practise);
    expect(window.location.hash).toBe('#trainer/add');
    await tick(20);
    expect(document.querySelector('.imp-sheet')).not.toBeNull();
    expect(ctl.calls).toContain('prepareClip');
    expect(document.querySelector('.imp-sheet')?.textContent).toMatch(/isolated-vocal/);
  });

  it('Results does not offer it without a reference clip', async () => {
    render();
    await goTo('#studio');
    await clickAsync(buttonNamed(/Try a demo take/));
    await tick(10);
    expect(Array.from(container.querySelectorAll('button')).some((b) => /Practise this phrase by phrase/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe('The Trainer in Progress, Settings and the Guide', () => {
  it('Progress shows the Phrases section even before any take is saved', async () => {
    render();
    await goTo('#progress');
    await tick();
    expect(container.querySelector('#hist-phrases')?.textContent).toBe('Phrases');
    // With Trainer clips the page is about them: no false "No saved takes yet" above the phrases, Studio takes are a quiet side section.
    expect(container.querySelector('.hist-empty')).toBeNull();
    expect(container.textContent).not.toMatch(/No saved takes yet/);
    expect(container.querySelector('#hist-studio')?.textContent).toBe('Studio takes');
    expect(container.querySelector('.pp-counts')).not.toBeNull();
  });

  it('Settings has the Trainer section, and Delete everything also clears the library', async () => {
    const ctl = render();
    await goTo('#settings');
    expect(container.querySelector('#trainer-heading')?.textContent).toBe('Trainer');
    await clickAsync(buttonNamed(/^Delete everything, including settings/));
    expect(container.querySelector('.confirm')?.textContent).toMatch(/every clip, phrase and practice score in the Trainer/);
    await clickAsync(buttonNamed(/Yes, delete everything/));
    expect(ctl.calls).toContain('clearAll');
    expect(ctl.clips).toHaveLength(0);
  });

  it('the empty state\'s help link opens the Guide at "Getting a vocal onto your phone"', async () => {
    render(makeFakeTrainerController({ clips: [] }));
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const help = Array.from(container.querySelectorAll('a')).find((a) => /How do I get a vocal/.test(a.textContent ?? ''));
    expect(help?.getAttribute('href')).toBe('#guide/guide-vocal');
    await goTo('#guide/guide-vocal');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(h1()).toMatch(/How Mimic listens/);
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement?.id).toBe('guide-vocal-h');
  });
});
