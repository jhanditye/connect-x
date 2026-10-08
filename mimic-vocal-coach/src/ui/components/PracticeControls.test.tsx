// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteInfo } from '../../audio/duplex';
import { DEFAULT_PRACTICE_OPTIONS, FAKE_ROUTE } from '../../testing/trainerFixtures';
import type { PracticeOptions, PracticeState } from '../../trainer/engine';
import { PracticeControls, PracticeDock, speedLabel, type PracticeControlsProps, type PracticeDockProps } from './PracticeControls';

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

const SPEAKER: RouteInfo = { inputLabel: 'iPhone Microphone', inputs: [{ id: 'b', label: 'iPhone Microphone' }], kind: 'builtin', headphonesLikely: false, sampleRate: 48000 };
const BLUETOOTH: RouteInfo = {
  inputLabel: 'AirPods Pro',
  inputs: [
    { id: 'a', label: 'AirPods Pro' },
    { id: 'b', label: 'iPhone Microphone' },
  ],
  kind: 'bluetooth',
  headphonesLikely: true,
  sampleRate: 16000,
  inputSampleRate: 16000,
};

function controls(over: Partial<PracticeControlsProps> = {}) {
  const onOptions = vi.fn();
  const p: PracticeControlsProps = { options: DEFAULT_PRACTICE_OPTIONS, state: 'idle', route: FAKE_ROUTE, keyHint: null, durationSec: 6.45, onOptions, ...over };
  act(() => root.render(<PracticeControls {...p} />));
  return { onOptions };
}
function dock(over: Partial<PracticeDockProps> = {}) {
  const f = { onOptions: vi.fn(), onListen: vi.fn(), onSing: vi.fn(), onStop: vi.fn(), onFinish: vi.fn() };
  const p: PracticeDockProps = { options: DEFAULT_PRACTICE_OPTIONS, state: 'idle', route: FAKE_ROUTE, hasResult: false, ...f, ...over };
  act(() => root.render(<PracticeDock {...p} />));
  return f;
}
const btn = (name: RegExp | string): HTMLButtonElement => {
  const b = Array.from(container.querySelectorAll('button')).find((el) => (typeof name === 'string' ? (el.textContent ?? '').trim() === name : name.test(el.textContent ?? '')));
  if (!b) throw new Error(`No button ${String(name)}`);
  return b;
};
const click = (el: Element) => act(() => (el as HTMLElement).click());
const pressed = () => Array.from(container.querySelectorAll('[aria-pressed="true"]')).map((e) => (e.textContent ?? '').trim());

describe('PracticeControls', () => {
  it('shows the choices as labelled groups with the current ones pressed', () => {
    controls();
    const groups = Array.from(container.querySelectorAll('[role="group"], fieldset')).map((g) => g.getAttribute('aria-labelledby') ?? g.querySelector('legend')?.textContent);
    expect(groups).toHaveLength(5);
    expect(container.textContent).toMatch(/Key.*Speed.*Mode.*Count-in.*Loop/s);
    expect(pressed()).toEqual(['Original', '100%', '3 beats']);
    expect((container.querySelector('input[value="sing-along"]') as HTMLInputElement).checked).toBe(true);
  });

  it('every speed is a button, and 50 percent is marked rough', () => {
    const { onOptions } = controls();
    const speeds = Array.from(container.querySelectorAll('.pc-row')).find((r) => /Speed/.test(r.textContent ?? ''))!.querySelectorAll('button');
    expect(Array.from(speeds).map((b) => b.textContent?.trim())).toEqual(['100%', '90%', '75%', '60%', '50% rough']);
    click(btn('75%'));
    expect(onOptions).toHaveBeenCalledWith({ rate: 0.75 });
    expect(speedLabel(0.9)).toBe('90%');
  });

  it('count-in and mode send their patches', () => {
    const { onOptions } = controls();
    click(btn(/4 beats/));
    expect(onOptions).toHaveBeenCalledWith({ countInBeats: 4 });
    act(() => (container.querySelector('input[value="turn-taking"]') as HTMLInputElement).click());
    expect(onOptions).toHaveBeenCalledWith({ mode: 'turn-taking' });
  });

  it('offers "My key" from the last good attempt, and Other opens a semitone stepper', () => {
    const { onOptions } = controls({ keyHint: -12 });
    expect(btn(/My key -12 \(octave\)/)).toBeTruthy();
    click(btn(/My key/));
    expect(onOptions).toHaveBeenCalledWith({ guideShift: -12 });
    expect(container.querySelector('.pc-stepper')).toBeNull();
    click(btn('Other'));
    expect(btn('Other').getAttribute('aria-expanded')).toBe('true');
    click(btn(/Higher/));
    expect(onOptions).toHaveBeenLastCalledWith({ guideShift: 1 });
    click(btn(/Lower/));
    expect(onOptions).toHaveBeenLastCalledWith({ guideShift: -1 });
  });

  it('shows a custom key on its chip and stops the stepper at an octave either way', () => {
    controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, guideShift: 3 } });
    expect(pressed()).toContain('My key +3');
    controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, guideShift: -12 } });
    click(btn(/My key -12/));
    expect(btn(/Lower/).disabled).toBe(true);
    expect(btn(/Higher/).disabled).toBe(false);
  });

  it('says "semitone" for one and "semitones" for more in the stepper\'s spoken value', () => {
    controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, guideShift: 1 } });
    click(btn(/My key \+1/));
    expect(container.querySelector('.pc-stepper-n')?.textContent).toBe('+1 semitone');
    controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, guideShift: -3 } });
    expect(container.querySelector('.pc-stepper-n')?.textContent).toBe('−3 semitones');
  });

  it('leaves out My key when the singer sang in the original key', () => {
    controls({ keyHint: 0 });
    expect(container.textContent).not.toMatch(/My key/);
    controls({ keyHint: null });
    expect(container.textContent).not.toMatch(/My key/);
  });

  it('loops the whole phrase with one button, and a part with its words and a Clear button', () => {
    const { onOptions } = controls();
    click(btn(/Whole phrase/));
    expect(onOptions).toHaveBeenCalledWith({ loop: { from: 0, to: 6.45 } });
    expect(container.textContent).toMatch(/Tap a note or drag across the strip/);
    const part = controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, loop: { from: 1.8, to: 3.4 } } });
    expect(container.textContent).toContain('1.8 s to 3.4 s');
    click(btn('Clear loop'));
    expect(part.onOptions).toHaveBeenCalledWith({ loop: null });
    const whole = controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, loop: { from: 0, to: 6.45 } } });
    expect(btn(/Whole phrase/).getAttribute('aria-pressed')).toBe('true');
    click(btn(/Whole phrase/));
    expect(whole.onOptions).toHaveBeenCalledWith({ loop: null });
  });

  it.each<PracticeState>(['preparing', 'processing', 'countin', 'singing'])('changes nothing while %s', (state) => {
    controls({ state });
    const all = Array.from(container.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'));
    expect(all.length).toBeGreaterThan(10);
    expect(all.every((b) => b.disabled)).toBe(true);
  });

  it('can be changed again after an interruption or an error', () => {
    for (const state of ['interrupted', 'error', 'result', 'idle', 'listening'] as PracticeState[]) {
      controls({ state });
      expect(btn('75%').disabled).toBe(false);
    }
  });

  it('warns about a Bluetooth microphone and offers the way to the microphone choice', () => {
    const onOpenMicSettings = vi.fn();
    controls({ route: BLUETOOTH, onOpenMicSettings });
    expect(container.textContent).toMatch(/Bluetooth microphone/);
    click(btn('Choose the microphone'));
    expect(onOpenMicSettings).toHaveBeenCalledOnce();
  });

  it('leaves the speaker advice to the Sing button, and shows a range message when there is one', () => {
    controls({ route: SPEAKER });
    expect(container.querySelector('.notice')).toBeNull();
    controls({ rangeMessage: 'This is below the range the app can follow. Sing it an octave up instead, or pick the original key.' });
    expect(container.querySelector('.notice')?.textContent).toMatch(/below the range/);
  });

  it('explains the two modes and says sing along needs headphones', () => {
    controls({ route: SPEAKER });
    expect(container.querySelector('.pc-hint')?.textContent).toMatch(/Needs headphones/);
    controls({ options: { ...DEFAULT_PRACTICE_OPTIONS, mode: 'turn-taking' } });
    expect(container.querySelector('.pc-hint')?.textContent).toMatch(/Works with the speaker/);
    controls({ route: FAKE_ROUTE });
    expect(container.querySelector('.pc-hint')?.textContent).toMatch(/Headphones on/);
  });
});

describe('PracticeDock', () => {
  it('Listen and Sing are big buttons, and each does its one thing', () => {
    const f = dock();
    click(btn(/Listen/));
    expect(f.onListen).toHaveBeenCalledOnce();
    click(btn(/^\s*Sing/));
    expect(f.onSing).toHaveBeenCalledOnce();
  });

  it('Sing becomes Try again after a result; while singing the right button is Done (it scores) and the left one cancels', () => {
    dock({ hasResult: true });
    expect(btn(/Try again/)).toBeTruthy();
    const singing = dock({ state: 'singing' });
    click(btn('Done'));
    expect(singing.onFinish).toHaveBeenCalledOnce();
    expect(singing.onStop).not.toHaveBeenCalled(); // Done never throws the take away
    click(btn('Cancel'));
    expect(singing.onStop).toHaveBeenCalledOnce();
    expect(singing.onFinish).toHaveBeenCalledOnce();
  });

  it('during the count-in the left button cancels and the right one cannot be tapped by mistake (a double tap on Sing does not cancel)', () => {
    const counting = dock({ state: 'countin' });
    click(btn(/Get ready/));
    expect(counting.onStop).not.toHaveBeenCalled();
    expect(counting.onSing).not.toHaveBeenCalled();
    expect(counting.onFinish).not.toHaveBeenCalled();
    click(btn('Cancel'));
    expect(counting.onStop).toHaveBeenCalledOnce();
  });

  it('Escape cancels a take (or stops the guide) without Tabbing back to the dock, and does nothing at rest', () => {
    const esc = () => act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const idle = dock();
    esc();
    expect(idle.onStop).not.toHaveBeenCalled();
    const singing = dock({ state: 'singing' });
    esc();
    expect(singing.onStop).toHaveBeenCalledOnce();
    const counting = dock({ state: 'countin' });
    esc();
    expect(counting.onStop).toHaveBeenCalledOnce();
    const listening = dock({ state: 'listening' });
    esc();
    expect(listening.onStop).toHaveBeenCalledOnce();
    act(() => root.render(<div />));
    esc(); // unmounted: no listener left
    expect(singing.onStop).toHaveBeenCalledOnce();
  });

  it('cancelling a take moves focus to Sing instead of dropping it', () => {
    dock({ state: 'singing' });
    const cancel = btn('Cancel');
    act(() => cancel.focus());
    click(cancel);
    expect(document.activeElement).toBe(btn('Done'));
  });

  it('the buttons keep their place while the take runs, so focus stays on the control that was pressed', () => {
    const f = dock();
    const sing = btn(/^\s*Sing/);
    act(() => sing.focus());
    click(sing);
    const p: PracticeDockProps = { options: DEFAULT_PRACTICE_OPTIONS, state: 'preparing', route: FAKE_ROUTE, hasResult: false, ...f };
    act(() => root.render(<PracticeDock {...p} />));
    expect(btn(/Getting ready/)).toBe(sing); // the same element, only aria-disabled
    expect(document.activeElement).toBe(sing);
    act(() => root.render(<PracticeDock {...p} state="countin" />));
    act(() => root.render(<PracticeDock {...p} state="singing" />));
    expect(btn('Done')).toBe(sing);
    expect(document.activeElement).toBe(sing);
  });

  it('Listen becomes Stop while the guide plays', () => {
    const f = dock({ state: 'listening' });
    click(btn('Stop'));
    expect(f.onStop).toHaveBeenCalledOnce();
    expect(f.onListen).not.toHaveBeenCalled();
  });

  it('cannot start anything while the phrase is getting ready or the take is being analysed, yet keeps focus (aria-disabled, not disabled)', () => {
    const f = dock({ state: 'preparing' });
    expect(btn(/Getting ready/).getAttribute('aria-disabled')).toBe('true');
    expect(btn(/Getting ready/).disabled).toBe(false);
    expect(btn(/Listen/).getAttribute('aria-disabled')).toBe('true');
    click(btn(/Getting ready/));
    click(btn(/Listen/));
    dock({ state: 'processing' });
    expect(btn(/Analysing/).getAttribute('aria-disabled')).toBe('true');
    click(btn(/Analysing/));
    expect(f.onSing).not.toHaveBeenCalled();
    expect(f.onListen).not.toHaveBeenCalled();
    expect(f.onStop).not.toHaveBeenCalled();
  });

  it('shows what the last action said above the buttons, as an alert for failures and a status otherwise', () => {
    dock({ state: 'error', note: { text: 'Microphone access was blocked.', tone: 'error' } });
    const alert = container.querySelector('.pd .pc-note[role="alert"]');
    expect(alert?.textContent).toContain('Microphone access was blocked.');
    expect(container.querySelector('.pd')?.firstElementChild).toBe(alert); // above the buttons, inside the pinned dock
    dock({ note: { text: 'Take cancelled. Nothing was scored.', tone: 'info' } });
    expect(container.querySelector('.pd [role="status"]')?.textContent).toContain('Take cancelled');
    expect(container.querySelector('.pd .pc-note[role="alert"]')).toBeNull();
  });

  it('a note can be dismissed, and focus goes to Sing', () => {
    const onDismissNote = vi.fn();
    dock({ note: { text: 'Playback did not start.', tone: 'error' }, onDismissNote });
    click(btn('Dismiss'));
    expect(onDismissNote).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(btn(/^\s*Sing/));
  });

  it('the question is not asked again once the engine has the yes (snapshot.speakerConfirmed)', () => {
    const f = dock({ route: SPEAKER, speakerConfirmed: true });
    click(btn(/^\s*Sing/));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(f.onSing).toHaveBeenCalledWith(true);
  });

  it('closing the question puts focus on Sing, not on the page', () => {
    dock({ route: SPEAKER });
    click(btn(/^\s*Sing/));
    click(btn('Cancel'));
    expect(document.activeElement).toBe(btn(/^\s*Sing/));
    click(btn(/^\s*Sing/));
    click(btn('I have headphones on'));
    expect(document.activeElement).toBe(btn(/^\s*Sing/));
  });

  it('tabbing to the dock does not leave the page scrolled to the bottom', () => {
    dock();
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    let y = 120;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y });
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    y = 783; // what the browser did to "make room" for the focus
    act(() => btn(/Listen/).focus());
    expect(scrollTo).toHaveBeenCalledWith(0, 120);
    // A click or a later focus is not a Tab: nothing is put back.
    scrollTo.mockClear();
    y = 300;
    act(() => btn(/^\s*Sing/).focus());
    expect(scrollTo).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, 'scrollY');
  });

  it('asks before singing along without headphones, and offers the safe way first', () => {
    const f = dock({ route: SPEAKER });
    click(btn(/^\s*Sing/));
    expect(f.onSing).not.toHaveBeenCalled();
    const ask = container.querySelector('[role="alert"]');
    expect(ask?.textContent).toMatch(/No headphones detected/);
    expect(document.activeElement?.textContent).toBe('Listen first, then sing');
    click(btn('Listen first, then sing'));
    expect(f.onOptions).toHaveBeenCalledWith({ mode: 'turn-taking' });
    expect(f.onSing).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('Escape closes the question without singing', () => {
    const f = dock({ route: SPEAKER });
    click(btn(/^\s*Sing/));
    const ask = container.querySelector('[role="alert"]') as HTMLElement;
    act(() => void ask.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(f.onSing).not.toHaveBeenCalled();
  });

  it('"I have headphones on" sings along and is not asked again; Cancel backs out', () => {
    const f = dock({ route: SPEAKER });
    click(btn(/^\s*Sing/));
    click(btn('Cancel'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(f.onSing).not.toHaveBeenCalled();
    click(btn(/^\s*Sing/));
    click(btn('I have headphones on'));
    expect(f.onSing).toHaveBeenCalledOnce();
    expect(f.onSing).toHaveBeenLastCalledWith(true); // the engine is told, so it does not ask a second time
    click(btn(/^\s*Sing/));
    expect(f.onSing).toHaveBeenCalledTimes(2);
    expect(f.onSing).toHaveBeenLastCalledWith(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not ask with headphones, in listen-then-sing, or when the browser has hidden the device names', () => {
    for (const p of [
      { route: FAKE_ROUTE },
      { route: SPEAKER, options: { ...DEFAULT_PRACTICE_OPTIONS, mode: 'turn-taking' } as PracticeOptions },
      { route: { ...SPEAKER, kind: 'unknown', labelsHidden: true } as RouteInfo },
      { route: null },
    ]) {
      const f = dock(p);
      click(btn(/^\s*Sing/));
      expect(f.onSing).toHaveBeenCalledOnce();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    }
  });
});
