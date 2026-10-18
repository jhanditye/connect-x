// @vitest-environment jsdom
// The Skills hub, the progress screen and the page that routes between them.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySkillsStore, loadSkillsStore, recordSkillsSession, resetSkillsStoreForTests, saveSkillsStore } from '../../skills/progress/store';
import { breathSession, earSession, matchSession, pitchTestSession, sequenceSession, singSession } from '../../skills/progress/testKit';
import type { SkillsStore, SkillsView } from '../../skills/types';
import type { AppSettings } from '../../types';
import { HUB_CARDS, lastResultLine, SkillsHub, whenText } from './SkillsHub';
import { SkillsPage } from './SkillsPage';
import { SkillsProgressScreen } from './SkillsProgressScreen';

vi.mock('./kit/sound', () => ({
  playPrompt: () => ({ done: Promise.resolve('ended'), stop() {}, playing: false, stalled: false, durationSec: 0 }),
  stopPrompt: () => {},
  loadPromptVolume: () => 0.35,
  savePromptVolume: (v: number) => v,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settings: AppSettings = { voiceType: 'tenor', a4Hz: 440, anthropicApiKey: null, aiModel: 'x' };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetSkillsStoreForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.location.hash = '';
});

function filledStore(): SkillsStore {
  let s = emptySkillsStore();
  const add = (x: Parameters<typeof recordSkillsSession>[1]) => (s = recordSkillsSession(s, x));
  add(pitchTestSession([{ register: 'low', heldCents: -10 }, { register: 'mid', heldCents: 5 }, { register: 'high', heldCents: -35 }, { register: 'high', heldCents: -30 }], 0, 'p1'));
  add(pitchTestSession([{ register: 'low', heldCents: -6 }, { register: 'mid', heldCents: 2 }, { register: 'high', heldCents: -25 }], 30, 'p2'));
  add(earSession([{ semitones: 7, correct: true }, { semitones: 5, correct: false }, { semitones: 4, direction: 'down', correct: true }], 40, 'e1'));
  add(singSession([{ semitones: 9, intervalCents: 30 }, { semitones: 9, direction: 'down', intervalCents: -12 }], 50, 's1'));
  for (let i = 0; i < 3; i++) add(sequenceSession([{ degree: 7, cents: -28 }, { degree: 6, cents: -4 }, { degree: 4, cents: 18 }, { degree: 7, cents: -24 }], 0.5, 60 + i, `q${i}`));
  add(breathSession({ hissSec: 14.2, pacedRounds: 2, maxExhale: 10 }, 70, 'b1'));
  add(matchSession([{ register: 'mid', heldCents: 4, locked: true }], 80, 'm1'));
  return s;
}

const text = () => container.textContent ?? '';

describe('SkillsHub', () => {
  function renderHub(store: SkillsStore) {
    const onOpen = vi.fn<(v: SkillsView) => void>();
    const onPrefs = vi.fn();
    act(() => root.render(<SkillsHub store={store} settings={settings} onOpen={onOpen} onPrefs={onPrefs} />));
    return { onOpen, onPrefs };
  }

  it('shows the workout first, then a card per exercise, each with its last result or "Not tried yet"', () => {
    renderHub(emptySkillsStore());
    expect(container.querySelector('h1')?.textContent).toBe('Build the fundamentals');
    const sections = Array.from(container.querySelectorAll('h2')).map((x) => x.textContent);
    expect(sections[0]).toMatch(/Today’s workout/);
    const cards = Array.from(container.querySelectorAll<HTMLAnchorElement>('a.sk-hub-card'));
    expect(cards.map((a) => a.getAttribute('href'))).toEqual(HUB_CARDS.map((c) => `#skills/${c.view}`));
    expect(cards.map((a) => a.querySelector('.sk-hub-card-name')?.textContent)[0]).toBe('How accurate is my pitch?');
    for (const a of cards) expect(a.textContent).toMatch(/Not tried yet/);
    expect(container.querySelectorAll('.sk-steps li')).toHaveLength(6);
    expect(text()).toMatch(/100 cents is one semitone/);
  });

  it('fills the cards from the store and opens a view on click (not on a modified click)', () => {
    const { onOpen } = renderHub(filledStore());
    const pitch = container.querySelector<HTMLAnchorElement>('a[data-view="pitch-test"]')!;
    expect(pitch.textContent).toMatch(/Last time: 11 cents off on average/);
    expect(container.querySelector('a[data-view="ear"]')?.textContent).toMatch(/2 of 3 right/);
    expect(container.querySelector('a[data-view="breath"]')?.textContent).toMatch(/Steady hiss for 14 s/);
    expect(text()).toMatch(/days? practised/);
    act(() => pitch.click());
    expect(onOpen).toHaveBeenCalledWith('pitch-test');
    // A Cmd-click is left to the browser (new tab); keep jsdom from following the link here.
    const hold = (e: Event) => e.preventDefault();
    window.addEventListener('click', hold);
    act(() => void pitch.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
    window.removeEventListener('click', hold);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const start = Array.from(container.querySelectorAll('a')).find((a) => /Start the workout/.test(a.textContent ?? ''))!;
    act(() => start.click());
    expect(onOpen).toHaveBeenLastCalledWith('workout');
  });

  it('changes strictness, label mode and key through onPrefs, and explains them in plain numbers', () => {
    const { onPrefs } = renderHub(emptySkillsStore());
    expect(text()).toMatch(/Within 25 cents \(a quarter of a semitone\)/);
    const radio = (value: string) => container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    act(() => radio('strict').click());
    expect(onPrefs).toHaveBeenCalledWith({ strictness: 'strict' });
    act(() => radio('solfege').click());
    expect(onPrefs).toHaveBeenCalledWith({ labelMode: 'solfege' });
    act(() => radio('natural-minor').click());
    expect(onPrefs).toHaveBeenCalledWith({ scaleMode: 'natural-minor' });
    expect(text()).toMatch(/C3 to G4 for a Tenor|C3 to G4 for a tenor/i);
  });

  it('describes when a session happened in plain words', () => {
    const now = new Date(2026, 9, 18, 12);
    expect(whenText(new Date(2026, 9, 18, 8).toISOString(), now)).toBe('today');
    expect(whenText(new Date(2026, 9, 17, 23).toISOString(), now)).toBe('yesterday');
    expect(whenText(new Date(2026, 9, 14, 9).toISOString(), now)).toBe('4 days ago');
    expect(lastResultLine([], 'ear')).toBeNull();
  });
});

describe('SkillsProgressScreen', () => {
  it('has an empty state that points to the pitch test and the workout', () => {
    act(() => root.render(<SkillsProgressScreen store={emptySkillsStore()} settings={settings} onExit={() => {}} />));
    expect(text()).toMatch(/Nothing here yet/);
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(expect.arrayContaining(['#skills/pitch-test', '#skills/workout']));
  });

  it('draws a chart per measured metric, the bests, the interval table, the degree profile and the registers', () => {
    const onExit = vi.fn();
    act(() => root.render(<SkillsProgressScreen store={filledStore()} settings={settings} onExit={onExit} />));
    const charts = Array.from(container.querySelectorAll('[data-metric]')).map((x) => x.getAttribute('data-metric'));
    expect(charts).toEqual(['pitch-mean-abs-cents', 'ear-accuracy', 'interval-abs-cents', 'sequence-accuracy', 'hiss-sec']);
    expect(text()).toMatch(/Not measured yet: Long tone: seconds/);
    const svg = container.querySelector('[data-metric="pitch-mean-abs-cents"] svg')!;
    expect(svg.getAttribute('aria-label')).toMatch(/2 sessions\. First 20 cents, latest 11 cents, best 11 cents\. Lower is better\./);
    expect(svg.querySelectorAll('circle')).toHaveLength(2);

    expect(container.querySelector('.sk-bests')?.textContent).toMatch(/14\.2 s/);

    const rows = Array.from(container.querySelectorAll('.sk-interval-table tbody tr')).map((tr) => tr.querySelector('th')?.textContent);
    expect(rows).toEqual(['M3 major 3rd', 'P4 perfect 4th', 'P5 perfect 5th', 'M6 major 6th']);
    const m6 = Array.from(container.querySelectorAll('.sk-interval-table tbody tr')).find((tr) => /M6/.test(tr.textContent ?? ''))!;
    expect(m6.textContent).toMatch(/30¢ off \(wide\) \(1\)/);
    expect(m6.textContent).toMatch(/12¢ off \(narrow\) \(1\)/);

    const bars = Array.from(container.querySelectorAll('.sk-bar-row'));
    expect(bars).toHaveLength(7);
    expect(bars[6].getAttribute('aria-label')).toMatch(/Degree 7 \(ti\): −26 cents over 6 notes/);
    expect(bars[0].getAttribute('aria-label')).toMatch(/not measured yet/);
    expect(text()).toMatch(/Your 7 tends to sit 26 cents flat \(over 6 notes\)/);

    const reg = Array.from(container.querySelectorAll('.sk-register-table tbody tr')).map((tr) => tr.textContent);
    expect(reg[2]).toMatch(/High third/);
    expect(reg[2]).toMatch(/flat/);
    expect(container.querySelectorAll('.sk-recent li').length).toBeGreaterThan(5);
    act(() => (container.querySelector('a.sk-back') as HTMLAnchorElement).click());
    expect(onExit).toHaveBeenCalled();
  });
});

describe('SkillsPage', () => {
  const go = async (hash: string) => {
    await act(async () => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
  };

  it('routes between the hub, the ear trainer and progress from the hash, and focuses the new view', async () => {
    window.location.hash = '#skills';
    act(() => root.render(<SkillsPage settings={settings} />));
    expect(container.querySelector('h1')?.textContent).toBe('Build the fundamentals');
    await go('#skills/ear?seed=3');
    expect(container.querySelector('h1')?.textContent).toBe('Interval ear training');
    expect(document.activeElement?.classList.contains('page--skills')).toBe(true);
    await go('#skills/progress');
    expect(container.querySelector('h1')?.textContent).toBe('Your Skills progress');
    await go('#skills/nowhere');
    expect(container.querySelector('h1')?.textContent).toBe('Build the fundamentals');
  });

  it('a back link returns to the hub; preferences and sessions are saved to the store and shown at once', async () => {
    window.location.hash = '#skills';
    act(() => root.render(<SkillsPage settings={settings} />));
    act(() => container.querySelector<HTMLInputElement>('input[type="radio"][value="gentle"]')!.click());
    expect(loadSkillsStore().prefs.strictness).toBe('gentle');
    expect(container.querySelector<HTMLInputElement>('input[type="radio"][value="gentle"]')!.checked).toBe(true);

    await act(async () => {
      saveSkillsStore(recordSkillsSession(loadSkillsStore(), earSession([{ semitones: 7, correct: true }], 0, 'live')));
    });
    expect(container.querySelector('a[data-view="ear"]')?.textContent).toMatch(/1 of 1 right/);

    await go('#skills/progress');
    act(() => (container.querySelector('a.sk-back') as HTMLAnchorElement).click());
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(window.location.hash).toBe('#skills');
    expect(container.querySelector('h1')?.textContent).toBe('Build the fundamentals');
  });
});
