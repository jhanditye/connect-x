// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passaggioFor } from '../../analysis/passaggio';
import { EXERCISES as LIBRARY } from '../../coach/exercises';
import { midiToNoteName } from '../../dsp/music';
import type { AppSettings, Exercise } from '../../types';
import { describePattern, PracticePage, patternSpan } from './Practice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' };

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function cards(section: string): HTMLElement[] {
  const heading = Array.from(container.querySelectorAll('h2')).find((h) => h.textContent === section);
  return heading ? Array.from(heading.closest('section')!.querySelectorAll<HTMLElement>('.ex-card')) : [];
}

function buttonIn(el: ParentNode, re: RegExp): HTMLButtonElement {
  const b = Array.from(el.querySelectorAll('button')).find((x) => re.test(x.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
}

const EXERCISES: readonly Exercise[] = LIBRARY;
const withPattern = EXERCISES.filter((e) => e.pattern);

describe('PracticePage', () => {
  it('lists the whole library when there is no plan focus', () => {
    act(() => root.render(<PracticePage settings={SETTINGS} />));
    expect(container.querySelector('h1')?.textContent).toBeTruthy();
    expect(cards('Exercise library')).toHaveLength(EXERCISES.length);
    expect(container.textContent).not.toContain('For you');
    // No Web Audio in jsdom: the player explains and disables itself.
    expect(container.textContent).toContain('cannot play practice tones');
  });

  it('shows the focus exercises first, without repeating them below', () => {
    const ids = EXERCISES.slice(0, 2).map((e) => e.id);
    act(() => root.render(<PracticePage settings={SETTINGS} focusExerciseIds={[...ids, 'no-such-exercise']} />));
    const focus = cards('For you');
    expect(focus.map((c) => c.querySelector('h3')?.textContent)).toEqual(EXERCISES.slice(0, 2).map((e) => e.name));
    expect(cards('More exercises')).toHaveLength(EXERCISES.length - 2);
  });

  it('filters the library by style dimension', () => {
    act(() => root.render(<PracticePage settings={SETTINGS} />));
    const chips = Array.from(container.querySelectorAll<HTMLButtonElement>('.filter-chip'));
    expect(chips[0].textContent).toBe('All');
    expect(chips.length).toBeGreaterThan(1);
    const key = EXERCISES.flatMap((e) => e.helps)[0];
    const expected = EXERCISES.filter((e) => e.helps.includes(key)).length;
    act(() => chips[1].click());
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(cards('Exercise library')).toHaveLength(expected);
  });

  it('shows the start note for the voice type and records a drill', () => {
    const onRecordDrill = vi.fn();
    act(() => root.render(<PracticePage settings={{ ...SETTINGS, voiceType: 'tenor' }} onRecordDrill={onRecordDrill} />));
    const first = cards('Exercise library')[0];
    act(() => buttonIn(first, /Record this drill/).click());
    expect(onRecordDrill).toHaveBeenCalledWith(EXERCISES[0].id);
    if (withPattern.length > 0) {
      const ex = withPattern[0];
      const p = ex.pattern!;
      const start = passaggioFor('tenor').lowMidi + p.startOffsetFromPassaggio + (p.steps[0] ?? 0);
      const card = cards('Exercise library').find((c) => c.querySelector('h3')?.textContent === ex.name)!;
      expect(card.textContent).toContain(`Starts on ${midiToNoteName(start)}`);
    }
  });

  it('plays and stops a pattern with Web Audio available', () => {
    if (withPattern.length === 0) return;
    vi.useFakeTimers();
    class Param {
      value = 0;
      setValueAtTime() {}
      linearRampToValueAtTime() {}
      exponentialRampToValueAtTime() {}
      cancelScheduledValues() {}
    }
    class Node {
      connect() {}
      disconnect() {}
    }
    vi.stubGlobal(
      'AudioContext',
      class {
        currentTime = 0;
        state = 'running';
        destination = new Node();
        resume() {
          return Promise.resolve();
        }
        createOscillator() {
          return Object.assign(new Node(), { frequency: new Param(), setPeriodicWave() {}, start() {}, stop() {} });
        }
        createGain() {
          return Object.assign(new Node(), { gain: new Param() });
        }
        createBiquadFilter() {
          return Object.assign(new Node(), { frequency: new Param(), Q: new Param() });
        }
        createPeriodicWave() {
          return {};
        }
      },
    );
    act(() => root.render(<PracticePage settings={SETTINGS} />));
    const ex = withPattern[0];
    const card = cards('Exercise library').find((c) => c.querySelector('h3')?.textContent === ex.name)!;
    const play = buttonIn(card, /Play pattern/);
    act(() => play.click());
    expect(play.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(card.querySelector('.ex-now')?.textContent).toMatch(/^[A-G]#?-?\d+ · round 1 of \d+$/);
    act(() => buttonIn(card, /Stop/).click());
    expect(play.getAttribute('aria-pressed')).toBe('false');
    expect(card.querySelector('.ex-now')?.textContent).toBe('');
  });
});

describe('Practice helpers', () => {
  const scale: NonNullable<Exercise['pattern']> = { kind: 'scale', steps: [0, 2, 4, 5, 7], bpm: 100, startOffsetFromPassaggio: -5, stepUpSemitones: 1, repetitions: 4 };

  it('describes a pattern in words', () => {
    expect(describePattern(scale)).toBe('Scale · 5 notes at 100 bpm · 4 rounds, up 1 semitone each time');
    expect(describePattern({ ...scale, kind: 'siren', repetitions: 1 })).toBe('Siren glide · one round');
    expect(describePattern({ ...scale, stepUpSemitones: -2 })).toContain('down 2 semitones each time');
  });

  it('computes the notes a pattern covers', () => {
    expect(patternSpan(scale, 62)).toEqual([57, 67]);
    expect(patternSpan({ ...scale, steps: [] }, 62)).toBeNull();
  });
});
