// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySkillsStore, recordSkillsSession } from '../../skills/progress/store';
import { earSession } from '../../skills/progress/testKit';
import { intervalQuestion } from '../../skills/theory/generate';
import { mulberry32 } from '../../skills/theory/rng';
import { DEFAULT_SKILLS_PREFS } from '../../skills/progress/parse';
import type { EarPlan, EarSession, SkillsPrefs, SkillsStats, ToneEvent } from '../../skills/types';
import type { AppSettings } from '../../types';
import { breakdown, degreeAnswerLabel, earConfigFrom, earFindings, EarTrainingScreen, intervalWeights } from './EarTrainingScreen';

const h = vi.hoisted(() => ({ played: [] as ToneEvent[][], stops: 0 }));
vi.mock('./kit/sound', () => ({
  playPrompt: (events: ToneEvent[]) => {
    h.played.push(events);
    return { durationSec: 0, done: Promise.resolve('ended' as const), stop() {}, playing: false, stalled: false };
  },
  stopPrompt: () => {
    h.stops++;
  },
  loadPromptVolume: () => 0.35,
  savePromptVolume: (v: number) => v,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'x' };
const emptyStats = (): SkillsStats => emptySkillsStore().stats;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.played.length = 0;
  h.stops = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tick = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function render(opts: { prefs?: Partial<SkillsPrefs>; plan?: EarPlan; embedded?: boolean; seed?: number; stats?: SkillsStats } = {}) {
  const onDone = vi.fn<(s: EarSession) => void>();
  const onExit = vi.fn();
  const onPrefs = vi.fn();
  act(() =>
    root.render(
      <EarTrainingScreen
        settings={settings}
        prefs={{ ...DEFAULT_SKILLS_PREFS, ...opts.prefs }}
        stats={opts.stats ?? emptyStats()}
        seed={opts.seed ?? 7}
        plan={opts.plan}
        embedded={opts.embedded}
        onDone={onDone}
        onExit={onExit}
        onPrefs={onPrefs}
      />,
    ),
  );
  return { onDone, onExit, onPrefs };
}

const buttons = () => Array.from(container.querySelectorAll('button'));
const button = (re: RegExp) => {
  const b = buttons().find((x) => re.test((x.textContent ?? '').trim()));
  if (!b) throw new Error(`no button ${re}: ${buttons().map((x) => x.textContent).join(' | ')}`);
  return b;
};
const answers = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.sk-answer'));
const press = (key: string, target: Element = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : undefined, bubbles: true, cancelable: true }));
  });
/** The right answer for the question on screen, read from the last played prompt (first two notes). */
function rightInterval(): number {
  const q = h.played[h.played.length - 1];
  if (q.length === 1) return Math.abs(q[0].midis[1] - q[0].midis[0]);
  return Math.abs(q[1].midis[0] - q[0].midis[0]);
}
const answerFor = (semitones: number) => answers().find((b) => b.getAttribute('aria-label')?.toLowerCase().startsWith(['', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th', 'tritone', 'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'][semitones]))!;

describe('EarTrainingScreen: intervals', () => {
  it('starts from the setup, plays a question and offers only the Starter set (P4, P5, P8, M3)', async () => {
    render();
    expect(container.querySelector('h1')?.textContent).toBe('Interval ear training');
    expect(container.textContent).toMatch(/No microphone needed/);
    act(() => button(/^Start/).click());
    await tick();
    expect(h.played).toHaveLength(1);
    expect(answers().map((b) => b.querySelector('.sk-answer-main')?.textContent)).toEqual(['M3', 'P4', 'P5', 'P8']);
    expect(container.textContent).toMatch(/Question 1 of 10/);
    expect([4, 5, 7, 12]).toContain(rightInterval());
  });

  it('answers with number keys, replays with Space, moves on with Return, and saves the session once at the end', async () => {
    const { onDone } = render({ plan: { mode: 'interval', questions: 3 } });
    // A plan starts on a ready card: Return starts it.
    press('Enter');
    await tick();
    expect(h.played).toHaveLength(1);
    press(' ');
    expect(h.played).toHaveLength(2);
    expect(h.played[1]).toEqual(h.played[0]);

    for (let i = 0; i < 3; i++) {
      const right = rightInterval();
      const idx = [4, 5, 7, 12].indexOf(right);
      press(String(idx + 1));
      await tick();
      expect(container.querySelector('.sk-feedback')?.textContent).toMatch(/^Right:/);
      expect(document.activeElement?.classList.contains('sk-feedback')).toBe(true);
      press('Enter');
      await tick();
    }
    expect(onDone).toHaveBeenCalledTimes(1);
    const s = onDone.mock.calls[0][0];
    expect(s.kind).toBe('ear');
    expect(s.mode).toBe('interval');
    expect(s.total).toBe(3);
    expect(s.correct).toBe(3);
    expect(s.answers.map((a) => a.replays)).toEqual([1, 0, 0]);
    expect(s.answers.every((a) => a.direction === 'up' || a.direction === 'down')).toBe(true);
    expect(container.querySelector('.sk-summary-title')?.textContent).toMatch(/3 of 3 right/);
    // Keys do nothing once finished.
    press('1');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('after a wrong answer says what it was and plays the answer and the right one side by side', async () => {
    render({ plan: { mode: 'interval', questions: 2 } });
    act(() => button(/Play the first question/).click());
    await tick();
    const right = rightInterval();
    const wrong = [4, 5, 7, 12].find((s) => s !== right)!;
    act(() => answerFor(wrong).click());
    await tick();
    const fb = container.querySelector('.sk-feedback')!;
    expect(fb.textContent).toMatch(/^Not quite: that was/);
    expect(fb.textContent).toMatch(/You chose/);
    expect(answerFor(right).className).toMatch(/sk-answer--right/);
    expect(answerFor(wrong).className).toMatch(/sk-answer--wrong/);
    const before = h.played.length;
    act(() => button(/Hear both, side by side/).click());
    const both = h.played[before];
    expect(both.some((e) => e.role === 'answer')).toBe(true);
    expect(both.some((e) => e.role === 'target' || e.role === 'reference')).toBe(true);
    act(() => button(/^Hear yours/).click());
    act(() => button(/^Hear the right one/).click());
    expect(h.played.length).toBe(before + 3);
    // Number keys are ignored until the next question.
    press('1');
    expect(container.querySelectorAll('.sk-answer--wrong')).toHaveLength(1);
  });

  it('ignores shortcut keys while a form control has focus or a modifier is held', async () => {
    render();
    const select = container.querySelector('select')!;
    select.focus();
    press('Enter', select);
    expect(h.played).toHaveLength(0);
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(h.played).toHaveLength(0);
  });

  it('a custom set offers exactly the chosen intervals, with 0, - and = keys past the ninth', async () => {
    const custom = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    render({ prefs: { earSetMode: 'custom', earCustom: custom } });
    act(() => button(/^Start/).click());
    await tick();
    expect(answers()).toHaveLength(12);
    const right = rightInterval();
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
    press(keys[right - 1]);
    await tick();
    expect(container.querySelector('.sk-feedback')?.textContent).toMatch(/^Right:/);
  });

  it('finishing early saves what was answered; leaving with nothing answered just exits', async () => {
    let r = render({ plan: { mode: 'interval', questions: 10 } });
    act(() => button(/Play the first question/).click());
    await tick();
    act(() => button(/^Leave$/).click());
    expect(r.onExit).toHaveBeenCalledTimes(1);
    expect(r.onDone).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(container);
    r = render({ plan: { mode: 'interval', questions: 10 } });
    act(() => button(/Play the first question/).click());
    await tick();
    act(() => answers()[0].click());
    await tick();
    act(() => button(/^Finish here$/).click());
    expect(r.onDone).toHaveBeenCalledTimes(1);
    expect(r.onDone.mock.calls[0][0].total).toBe(1);
  });

  it('saves set changes as preferences', () => {
    const { onPrefs } = render();
    const level = container.querySelector<HTMLSelectElement>('#sk-ear-level')!;
    act(() => {
      level.value = '2';
      level.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onPrefs).toHaveBeenCalledWith({ earLevel: 2 });
    expect(Array.from(container.querySelectorAll('.sk-set-chips .chip')).map((c) => c.textContent)).toEqual(['M2', 'm3', 'M3', 'P4', 'P5', 'P8']);
  });
});

describe('EarTrainingScreen: hear the degree', () => {
  it('plays the cadence then one note and takes 1-7 from the keyboard', async () => {
    const { onDone } = render({ plan: { mode: 'degree', questions: 2 }, embedded: true });
    expect(container.querySelector('h1')).toBeNull();
    press('Enter');
    await tick();
    const prompt = h.played[0];
    expect(prompt.filter((e) => e.role === 'cadence')).toHaveLength(4);
    expect(prompt[prompt.length - 1].role).toBe('target');
    expect(answers().map((b) => b.querySelector('.sk-answer-main')?.textContent)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    press('5');
    await tick();
    press('Enter');
    await tick();
    press('3');
    await tick();
    press('Enter');
    await tick();
    expect(onDone).toHaveBeenCalledTimes(1);
    const s = onDone.mock.calls[0][0];
    expect(s.mode).toBe('degree');
    expect(s.answers.map((a) => a.chosenValue)).toEqual([5, 3]);
    expect(s.answers.every((a) => a.mode === 'major' && a.direction === null)).toBe(true);
    // Embedded: no "Go again" or back buttons, the workout moves on.
    expect(buttons().some((b) => /Go again/.test(b.textContent ?? ''))).toBe(false);
  });

  it('labels degrees in the chosen display mode', () => {
    expect(degreeAnswerLabel(7, 'major', 'numbers', 60)).toEqual({ main: '7', sub: 'ti' });
    expect(degreeAnswerLabel(3, 'natural-minor', 'solfege', 60)).toEqual({ main: 'me', sub: '3' });
    expect(degreeAnswerLabel(7, 'major', 'names', 66).main).toBe('E♯');
  });
});

describe('ear training helpers', () => {
  it('adaptive weights favour weak intervals, and every interval keeps a floor', () => {
    let store = emptySkillsStore();
    store = recordSkillsSession(store, earSession([...Array(8)].map(() => ({ semitones: 7, correct: true })), 0, 'a'));
    store = recordSkillsSession(store, earSession([...Array(8)].map(() => ({ semitones: 5, correct: false })), 1, 'b'));
    const w = intervalWeights(store.stats, [4, 5, 7, 12], ['up']);
    const [m3, p4, p5, p8] = w;
    expect(p4).toBeGreaterThan(p5);
    expect(p4).toBeGreaterThan(m3);
    expect(m3).toBeCloseTo(p8);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0.15);
    // Over 400 seeded questions, the missed 4th comes up far more often than the mastered 5th.
    const rng = mulberry32(3);
    const counts = new Map<number, number>();
    for (let i = 0; i < 400; i++) {
      const q = intervalQuestion(rng, [4, 5, 7, 12], { lowMidi: 45, highMidi: 65 }, { directions: ['up'], weights: w });
      if (q.kind === 'interval') counts.set(q.semitones, (counts.get(q.semitones) ?? 0) + 1);
    }
    expect(counts.get(5)!).toBeGreaterThan(2 * counts.get(7)!);
    expect(counts.get(7)!).toBeGreaterThan(0);
  });

  it('config comes from the plan when there is one, else from the preferences', () => {
    expect(earConfigFrom(DEFAULT_SKILLS_PREFS).set).toEqual([4, 5, 7, 12]);
    expect(earConfigFrom({ ...DEFAULT_SKILLS_PREFS, earLevel: 3 }).set).toEqual([2, 3, 4, 5, 7, 8, 9, 12]);
    const c = earConfigFrom({ ...DEFAULT_SKILLS_PREFS, earSetMode: 'adaptive' }, { mode: 'interval', questions: 10, set: [12, 3, 5] });
    expect(c.set).toEqual([3, 5, 12]);
    expect(c.adaptive).toBe(false);
    expect(earConfigFrom({ ...DEFAULT_SKILLS_PREFS, earSetMode: 'adaptive' }).adaptive).toBe(true);
  });

  it('findings name the most common mix-up, never "fail"', () => {
    const s = earSession(
      [
        { semitones: 5, correct: false },
        { semitones: 5, correct: false },
        { semitones: 7, correct: true },
      ],
      0,
      'x',
    );
    s.answers[0].chosenValue = 7;
    s.answers[1].chosenValue = 7;
    const f = earFindings(s.answers, 'interval');
    expect(f.map((x) => x.text).join(' ')).toMatch(/You heard the perfect 4th as a perfect 5th twice/);
    expect(f.map((x) => x.text).join(' ')).not.toMatch(/fail/i);
    expect(breakdown(s)[0]).toEqual({ key: '5up', label: 'Perfect 4th up', asked: 2, right: 0 });
  });
});
