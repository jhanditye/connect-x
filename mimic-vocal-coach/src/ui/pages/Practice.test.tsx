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
    // On a phone "For you" comes straight after the intro, before the reference pitch tool.
    const order = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(order).toEqual(['For you', 'Reference pitch', 'More exercises']);
  });

  it('keeps library steps behind a disclosure, open only on the focus cards', () => {
    const ex = EXERCISES.find((e) => e.steps.length > 1)!;
    const other = EXERCISES.find((e) => e.id !== ex.id && e.steps.length > 0)!;
    act(() => root.render(<PracticePage settings={SETTINGS} focusExerciseIds={[ex.id]} />));
    const focusDetails = cards('For you')[0].querySelector('details')!;
    expect(focusDetails.open).toBe(true);
    const card = cards('More exercises').find((c) => c.querySelector('h3')?.textContent === other.name)!;
    const details = card.querySelector('details')!;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toBe(`How to do it (${other.steps.length} step${other.steps.length === 1 ? '' : 's'})`);
    // The steps are in the DOM (find-in-page works) and the disclosure opens natively.
    expect(details.querySelectorAll('.ex-steps li')).toHaveLength(other.steps.length);
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(details.open).toBe(true);
    // Cautions stay visible outside the disclosure.
    const withCaution = cards('More exercises').find((c) => c.querySelector('.ex-cautions'));
    if (withCaution) expect(withCaution.querySelector('details .ex-cautions')).toBeNull();
  });

  it('names the voice type plainly in running text and says rounds are optional', () => {
    act(() => root.render(<PracticePage settings={{ ...SETTINGS, voiceType: 'mezzo' }} />));
    const lede = container.querySelector('.lede')!.textContent!;
    expect(lede).toContain('your mezzo-soprano voice');
    expect(container.textContent).not.toContain('(most female pop voices)');
    expect(container.querySelector('.practice-safety')?.textContent).toContain('you don’t need to finish every round');
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

  it('announces the start, each round and the stop to screen readers, not every note', () => {
    const ex = withPattern.find((e) => e.pattern!.repetitions > 1 && e.pattern!.kind !== 'siren' && e.pattern!.steps.length > 2);
    if (!ex) return;
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
    const card = cards('Exercise library').find((c) => c.querySelector('h3')?.textContent === ex.name)!;
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');
    // The per-note readout is visual only.
    expect(card.querySelector('.ex-now')?.getAttribute('aria-hidden')).toBe('true');
    expect(card.querySelector('.ex-now')?.hasAttribute('aria-live')).toBe(false);
    const announcements: string[] = [];
    const sample = () => {
      const text = status.textContent ?? '';
      if (text !== announcements[announcements.length - 1]) announcements.push(text);
    };
    act(() => buttonIn(card, /Play pattern/).click());
    sample();
    const secPerBeat = 60 / ex.pattern!.bpm;
    const beatsPerRound = ex.pattern!.steps.length * (ex.pattern!.kind === 'sustain' ? 4 : 1) + 2;
    // Play through the first round and into the second, checking the status at every quarter beat.
    for (let i = 0; i < (beatsPerRound + 2) * 4; i++) {
      act(() => {
        vi.advanceTimersByTime((secPerBeat * 1000) / 4);
      });
      sample();
    }
    const reps = ex.pattern!.repetitions;
    const rounds = announcements.filter((a) => /round/i.test(a));
    expect(rounds[0]).toMatch(new RegExp(`^Playing ${ex.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: round 1 of ${reps}, starting on [A-G]#?\\d\\.$`));
    expect(rounds[1]).toMatch(new RegExp(`^Round 2 of ${reps}, starting on [A-G]#?\\d\\.$`));
    // One update per round (plus the start), not one per note.
    expect(announcements.length).toBeLessThanOrEqual(3);
    act(() => buttonIn(card, /Stop/).click());
    expect(status.textContent).toBe('Pattern stopped.');
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
