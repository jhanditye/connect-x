// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptySkillsStore, recordSkillsSession } from '../../skills/progress/store';
import { breathSession, earSession, matchSession, sequenceSession, singSession } from '../../skills/progress/testKit';
import type { SkillsSession, SkillsStore, WorkoutSession } from '../../skills/types';
import type { AppSettings } from '../../types';
import { stepSeed, WorkoutScreen } from './WorkoutScreen';

// Each step screen is replaced by a stub that shows its plan and finishes (or exits) on a button, so the test checks the
// workout's sequencing, not the exercises (those have their own tests).
const h = vi.hoisted(() => {
  const seen: { kind: string; plan: unknown; embedded: boolean | undefined; seed: number | undefined }[] = [];
  type CE = typeof import('react').createElement;
  type P = { plan?: unknown; embedded?: boolean; seed?: number; onDone(s: unknown): void; onExit(): void };
  const make = (ce: CE, kind: string, finish: (kind: string) => unknown) => (p: P) => {
    seen.push({ kind, plan: p.plan, embedded: p.embedded, seed: p.seed });
    return ce(
      'div',
      { className: 'stub', 'data-kind': kind },
      ce('button', { type: 'button', onClick: () => p.onDone(finish(kind)) }, `finish ${kind}`),
      ce('button', { type: 'button', onClick: () => p.onExit() }, `exit ${kind}`),
    );
  };
  const box = { seen, make, finish: null as unknown as (kind: string) => unknown, stubOf: null as unknown as (kind: string) => Promise<(p: P) => unknown> };
  box.stubOf = async (kind: string) => {
    const { createElement } = await import('react');
    return make(createElement, kind, (k) => box.finish(k));
  };
  return box;
});
vi.mock('./kit/sound', () => ({ playPrompt: () => ({ done: Promise.resolve('ended'), stop() {}, playing: false, stalled: false, durationSec: 0 }), stopPrompt: () => {} }));
vi.mock('./sing/BreathScreen', async () => ({ BreathScreen: await h.stubOf('breath') }));
vi.mock('./sing/MatchNoteScreen', async () => ({ MatchNoteScreen: await h.stubOf('match') }));
vi.mock('./sing/SingIntervalsScreen', async () => ({ SingIntervalsScreen: await h.stubOf('sing-intervals') }));
vi.mock('./sing/SequenceScreen', async () => ({ SequenceScreen: await h.stubOf('sequence') }));
vi.mock('./EarTrainingScreen', async () => ({ EarTrainingScreen: await h.stubOf('ear') }));

let n = 0;
function fakeSession(kind: string): SkillsSession {
  const id = `step-${kind}-${++n}`;
  switch (kind) {
    case 'breath':
      return breathSession({ pacedRounds: 2, maxExhale: 10, hissSec: 12 }, 0, id);
    case 'match':
      return matchSession([{ register: 'mid', heldCents: 8, locked: true }], 0, id);
    case 'ear':
      return earSession([{ semitones: 7, correct: true }, { semitones: 5, correct: false }], 0, id);
    case 'sing-intervals':
      return singSession([{ semitones: 9, intervalCents: 20 }], 0, id);
    default:
      return sequenceSession([{ degree: 7, cents: -30 }], 0.5, 0, id);
  }
}
h.finish = fakeSession;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settings: AppSettings = { voiceType: 'tenor', a4Hz: 440, anthropicApiKey: null, aiModel: 'x' };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.seen.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const click = (re: RegExp) =>
  act(() => {
    const b = Array.from(container.querySelectorAll('button')).find((x) => re.test((x.textContent ?? '').trim()));
    if (!b) throw new Error(`no button ${re}`);
    b.click();
  });
const stubKind = () => container.querySelector('.stub')?.getAttribute('data-kind') ?? null;

/** Renders the workout with a parent that saves step sessions into the store, like SkillsPage does. */
function mount(seed = 11) {
  let store: SkillsStore = emptySkillsStore();
  const steps: SkillsSession[] = [];
  const onDone = vi.fn<(w: WorkoutSession) => void>();
  const onExit = vi.fn();
  const draw = () =>
    act(() =>
      root.render(
        <WorkoutScreen
          settings={settings}
          prefs={store.prefs}
          stats={store.stats}
          store={store}
          seed={seed}
          onDone={(w) => {
            onDone(w);
            store = recordSkillsSession(store, w);
            draw();
          }}
          onExit={onExit}
          onStepDone={(s) => {
            steps.push(s);
            store = recordSkillsSession(store, s);
            draw();
          }}
        />,
      ),
    );
  draw();
  return { steps, onDone, onExit, store: () => store };
}

describe('WorkoutScreen', () => {
  it('lists the six steps with times and the breath safety notes before starting', () => {
    mount();
    const items = Array.from(container.querySelectorAll('.sk-steps li')).map((li) => li.textContent);
    expect(items).toHaveLength(6);
    expect(items[0]).toMatch(/Breathing: 2 slow rounds/);
    expect(items[5]).toMatch(/Hiss test/);
    expect(container.textContent).toMatch(/dizzy or light-headed/);
    expect(stubKind()).toBeNull();
  });

  it('runs each step embedded with its plan, saves every step with the workout id, and records one workout at the end', () => {
    const r = mount();
    click(/Start the workout/);
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      const kind = stubKind()!;
      order.push(kind);
      click(new RegExp(`^finish ${kind}$`));
      expect(container.querySelector('.sk-between-title')?.textContent).toMatch(/done$/);
      expect(document.activeElement?.classList.contains('sk-between-title')).toBe(true);
      click(/^(Next step|See the summary)/);
    }
    expect(order).toEqual(['breath', 'match', 'ear', 'sing-intervals', 'sequence', 'breath']);
    // Plans reach the screens: paced breathing first, the hiss test last, ten ear questions, two sequence texts.
    const plans = h.seen.filter((s, i, all) => all.findIndex((x) => x.kind === s.kind && x.plan === s.plan) === i);
    expect(plans.every((p) => p.embedded === true)).toBe(true);
    expect(plans.find((p) => p.kind === 'breath')?.plan).toEqual({ parts: ['paced'], pacedRounds: 2 });
    expect(plans.filter((p) => p.kind === 'breath').map((p) => (p.plan as { parts: string[] }).parts)).toEqual([['paced'], ['hiss']]);
    expect((plans.find((p) => p.kind === 'ear')?.plan as { questions: number }).questions).toBe(10);
    expect((plans.find((p) => p.kind === 'sequence')?.plan as { texts: string[] }).texts).toHaveLength(2);
    expect(new Set(h.seen.map((s) => s.seed)).size).toBe(6);

    expect(r.steps).toHaveLength(6);
    const wid = r.steps[0].workoutId;
    expect(wid).toBeTruthy();
    expect(r.steps.every((s) => s.workoutId === wid)).toBe(true);
    expect(r.onDone).toHaveBeenCalledTimes(1);
    const w = r.onDone.mock.calls[0][0];
    expect(w.kind).toBe('workout');
    expect(w.partIds).toEqual(r.steps.map((s) => s.id));
    expect(w.completedSteps).toBe(6);
    expect(w.totalSteps).toBe(6);
    expect(container.querySelector('.sk-summary-title')?.textContent).toMatch(/Workout done: 6 of 6 steps/);
    expect(container.querySelectorAll('.sk-summary .sk-finding').length).toBeGreaterThan(0);
  });

  it('skipping a step (from the bar or from the screen) moves on without saving it', () => {
    const r = mount();
    click(/Start the workout/);
    click(/^Skip this step$/);
    expect(stubKind()).toBe('match');
    click(/^exit match$/);
    expect(stubKind()).toBe('ear');
    click(/^finish ear$/);
    click(/^Next step/);
    click(/^End workout$/);
    expect(r.steps.map((s) => s.kind)).toEqual(['ear']);
    expect(r.onDone).toHaveBeenCalledTimes(1);
    const w = r.onDone.mock.calls[0][0];
    expect(w.completedSteps).toBe(1);
    expect(w.partIds).toEqual([r.steps[0].id]);
    const lines = Array.from(container.querySelectorAll('.sk-summary .sk-steps li')).map((li) => li.textContent);
    expect(lines[0]).toMatch(/skipped/);
    expect(lines[2]).toMatch(/1 of 2 right/);
    expect(lines[5]).toMatch(/not reached/);
  });

  it('ending before any step is finished records nothing and goes back', () => {
    const r = mount();
    click(/Start the workout/);
    click(/^End workout$/);
    expect(r.onDone).not.toHaveBeenCalled();
    expect(r.onExit).toHaveBeenCalledTimes(1);
  });

  it('a step that reports twice is saved once', () => {
    const r = mount();
    click(/Start the workout/);
    const finish = Array.from(container.querySelectorAll('button')).find((b) => /^finish breath$/.test(b.textContent ?? ''))!;
    act(() => {
      finish.click();
      finish.click();
    });
    expect(r.steps).toHaveLength(1);
  });

  it('per-step seeds are fixed for a seeded workout and absent otherwise', () => {
    expect(stepSeed(undefined, 2)).toBeUndefined();
    expect(stepSeed(5, 0)).toBe(stepSeed(5, 0));
    expect(stepSeed(5, 0)).not.toBe(stepSeed(5, 1));
  });
});
