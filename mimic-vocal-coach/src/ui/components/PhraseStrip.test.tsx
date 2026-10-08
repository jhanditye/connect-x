// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_PHRASE_NOTES, FAKE_PHRASE_SEC, makeFakePhraseAnalysis } from '../../testing/trainerFixtures';
import { loopForNote, loopText, MIN_LOOP_SEC, PhraseStrip, sameLoop, stripNotes, type Loop, type PhraseStripProps } from './PhraseStrip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const reference = makeFakePhraseAnalysis();

function props(over: Partial<PhraseStripProps> = {}): PhraseStripProps {
  return {
    reference,
    durationSec: FAKE_PHRASE_SEC,
    shift: 0,
    loop: null,
    onLoopChange: vi.fn(),
    getPosition: () => Number.NaN,
    getLiveMidi: () => null,
    playing: false,
    singing: false,
    countIn: null,
    ...over,
  };
}
const render = (p: PhraseStripProps) => act(() => root.render(<PhraseStrip {...p} />));
const svg = () => container.querySelector('svg.ps-svg') as SVGSVGElement;
const chips = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.ps-chip'));
/** The width the strip falls back to without layout is 340: the plot starts at 34 px and is 298 px wide. */
const clientXAt = (t: number) => 34 + (t / FAKE_PHRASE_SEC) * 298;
function pointer(type: string, x: number, target: Element = svg()) {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 40 }));
  });
}
const runFrame = () => act(() => frames.splice(0).forEach((f) => f(0)));

describe('PhraseStrip helpers', () => {
  it('reads the notes in the key the guide plays in', () => {
    const n = stripNotes(reference, -12, FAKE_PHRASE_SEC);
    expect(n).toHaveLength(8);
    expect(n[0]).toMatchObject({ name: 'G2', midi: 43 });
    expect(stripNotes(reference, 0, FAKE_PHRASE_SEC)[3].name).toBe('E4');
    expect(stripNotes(null, 0, 6)).toEqual([]);
  });

  it('clips notes to the phrase window and drops the ones outside it', () => {
    const n = stripNotes(reference, 0, 2);
    expect(n.length).toBeLessThan(8);
    expect(n.every((x) => x.end <= 2)).toBe(true);
  });

  it('loops a note with a little room, inside the phrase and never shorter than the minimum', () => {
    const first = loopForNote({ start: FAKE_PHRASE_NOTES[0].start, end: FAKE_PHRASE_NOTES[0].end }, FAKE_PHRASE_SEC);
    expect(first.from).toBeCloseTo(0.1, 5);
    expect(first.to).toBeCloseTo(0.9, 5);
    const tiny = loopForNote({ start: 1, end: 1.05 }, FAKE_PHRASE_SEC);
    expect(tiny.to - tiny.from).toBeGreaterThanOrEqual(MIN_LOOP_SEC - 1e-9);
    const edge = loopForNote({ start: 0, end: 0.05 }, 6);
    expect(edge.from).toBe(0);
    const last = loopForNote({ start: 5.9, end: 6 }, 6);
    expect(last.to).toBeLessThanOrEqual(6);
  });

  it('compares loops and words them', () => {
    expect(sameLoop({ from: 1, to: 2 }, { from: 1.01, to: 2 })).toBe(true);
    expect(sameLoop({ from: 1, to: 2 }, { from: 1.5, to: 2 })).toBe(false);
    expect(sameLoop(null, { from: 1, to: 2 })).toBe(false);
    expect(loopText(null, 6)).toBe('The whole phrase');
    expect(loopText({ from: 0, to: 6 }, 6)).toBe('The whole phrase, on repeat');
    expect(loopText({ from: 1.8, to: 3.4 }, 6)).toBe('1.8 s to 3.4 s');
  });
});

describe('PhraseStrip', () => {
  it('draws the original in the guide key: a grid with note names, a bar per note, one chip per note', () => {
    render(props({ shift: -12 }));
    expect(svg().getAttribute('role')).toBe('img');
    expect(svg().getAttribute('aria-label')).toMatch(/8 notes from G2 to E3, 6\.\d seconds/);
    expect(svg().getAttribute('aria-label')).toMatch(/Tap a note to loop it/);
    expect(container.querySelectorAll('.ps-note')).toHaveLength(8);
    expect(Array.from(container.querySelectorAll('.ps-tick')).some((t) => t.textContent === 'C3')).toBe(true);
    expect(chips()).toHaveLength(8);
    expect(chips()[0].getAttribute('aria-label')).toBe('Loop note 1, G2');
    expect(container.querySelector('.ps-notes')?.getAttribute('aria-label')).toBe('Loop one note');
  });

  it('every note chip is a button that loops that note, and a second tap clears it', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange }));
    act(() => chips()[3].click());
    const asked = onLoopChange.mock.calls[0][0] as Loop;
    expect(asked.from).toBeCloseTo(FAKE_PHRASE_NOTES[3].start - 0.05, 5);
    expect(asked.to).toBeCloseTo(FAKE_PHRASE_NOTES[3].end + 0.05, 5);
    render(props({ onLoopChange, loop: asked }));
    expect(chips()[3].getAttribute('aria-pressed')).toBe('true');
    expect(chips()[2].getAttribute('aria-pressed')).toBe('false');
    act(() => chips()[3].click());
    expect(onLoopChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the loop region and its two edges, and a whole-phrase loop without edges', () => {
    render(props({ loop: { from: 1.8, to: 3.4 } }));
    expect(container.querySelector('.ps-loop')).not.toBeNull();
    expect(container.querySelectorAll('.ps-edge')).toHaveLength(2);
    expect(svg().getAttribute('aria-label')).toMatch(/Looping 1\.8 s to 3\.4 s/);
    render(props({ loop: { from: 0, to: FAKE_PHRASE_SEC } }));
    expect(container.querySelectorAll('.ps-edge')).toHaveLength(0);
    expect(container.querySelector('.ps-loop--whole')).not.toBeNull();
  });

  it('a tap on a note loops it; a tap on empty space does nothing', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange }));
    const mid = (FAKE_PHRASE_NOTES[3].start + FAKE_PHRASE_NOTES[3].end) / 2;
    pointer('pointerdown', clientXAt(mid));
    pointer('pointerup', clientXAt(mid));
    expect(onLoopChange).toHaveBeenCalledTimes(1);
    expect((onLoopChange.mock.calls[0][0] as Loop).from).toBeCloseTo(FAKE_PHRASE_NOTES[3].start - 0.05, 5);
    pointer('pointerdown', clientXAt(FAKE_PHRASE_SEC - 0.05));
    pointer('pointerup', clientXAt(FAKE_PHRASE_SEC - 0.05));
    // The last note ends at 6.25; 6.4 is past it by more than the allowance, so there is no note under the finger.
    expect(onLoopChange).toHaveBeenCalledTimes(1);
  });

  it('dragging across the strip loops that stretch, and a tiny wobble is still a tap', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange }));
    pointer('pointerdown', clientXAt(1));
    pointer('pointermove', clientXAt(2.5));
    expect(container.querySelector('.ps-loop')).not.toBeNull();
    pointer('pointerup', clientXAt(2.5));
    const loop = onLoopChange.mock.calls[0][0] as Loop;
    expect(loop.from).toBeCloseTo(1, 1);
    expect(loop.to).toBeCloseTo(2.5, 1);
    onLoopChange.mockClear();
    pointer('pointerdown', clientXAt(1));
    pointer('pointermove', clientXAt(1.05));
    pointer('pointerup', clientXAt(1.05));
    // Two pixels of finger wobble on the second note is a tap on that note, not a loop of its own length.
    const tap = onLoopChange.mock.calls[0][0] as Loop;
    expect(tap.from).toBeCloseTo(FAKE_PHRASE_NOTES[1].start - 0.05, 5);
    expect(tap.to).toBeCloseTo(FAKE_PHRASE_NOTES[1].end + 0.05, 5);
  });

  it('dragging backwards still makes a loop with from before to', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange }));
    pointer('pointerdown', clientXAt(4));
    pointer('pointermove', clientXAt(2));
    pointer('pointerup', clientXAt(2));
    const loop = onLoopChange.mock.calls[0][0] as Loop;
    expect(loop.from).toBeLessThan(loop.to);
  });

  it('an edge can be dragged to adjust the loop', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange, loop: { from: 1.8, to: 3.4 } }));
    const grip = container.querySelector('[data-edge="to"]') as Element;
    pointer('pointerdown', clientXAt(3.4), grip);
    pointer('pointermove', clientXAt(4.2));
    pointer('pointerup', clientXAt(4.2));
    const loop = onLoopChange.mock.calls[0][0] as Loop;
    expect(loop.from).toBeCloseTo(1.8, 5);
    expect(loop.to).toBeCloseTo(4.2, 1);
  });

  it('does nothing while it is disabled, and shows no chips without a reference', () => {
    const onLoopChange = vi.fn();
    render(props({ onLoopChange, disabled: true }));
    pointer('pointerdown', clientXAt(2));
    pointer('pointerup', clientXAt(2));
    expect(onLoopChange).not.toHaveBeenCalled();
    expect(chips().every((c) => c.disabled)).toBe(true);
    render(props({ reference: null }));
    expect(chips()).toHaveLength(0);
    expect(svg().getAttribute('aria-label')).toBe('The phrase is loading. Tap a note to loop it, or drag across the strip.');
  });

  it('moves the playhead on animation frames, not through state, and hides it when nothing plays', () => {
    let pos = 2;
    render(props({ playing: true, getPosition: () => pos }));
    runFrame();
    const head = container.querySelector('.ps-head') as SVGLineElement;
    expect(head.getAttribute('visibility')).toBe('visible');
    const x1 = Number(head.getAttribute('x1'));
    expect(x1).toBeCloseTo((2 / FAKE_PHRASE_SEC) * 298, 0);
    pos = 4;
    runFrame();
    expect(Number(head.getAttribute('x1'))).toBeGreaterThan(x1);
    render(props({ playing: false }));
    expect(head.getAttribute('visibility')).toBe('hidden');
  });

  it('draws your live pitch while you sing and clears it afterwards', () => {
    render(props({ singing: true, playing: true, getPosition: () => 1, getLiveMidi: () => 57 }));
    runFrame();
    const live = container.querySelector('.ps-live') as SVGPolylineElement;
    expect(live.getAttribute('points')).toMatch(/^\d/);
    render(props({ singing: false, playing: false }));
    expect(live.getAttribute('points')).toBe('');
  });

  it('shows the count-in numeral as decoration', () => {
    render(props({ countIn: 3 }));
    const c = container.querySelector('.ps-count') as HTMLElement;
    expect(c.textContent).toBe('3');
    expect(c.getAttribute('aria-hidden')).toBe('true');
    render(props({ countIn: null }));
    expect(container.querySelector('.ps-count')).toBeNull();
  });
});
