// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisFromSpans, fakePrepared } from '../../trainer/importTestKit';
import { segmentPhrases, type SegPhrase } from '../../trainer/segment';
import { bandAt, contourLines, formatEdgeTime, NUDGE_SEC, PhraseEditor, waveformPath, ZOOM_LEVELS, type PhraseEditorProps } from './PhraseEditor';

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
  vi.unstubAllGlobals();
});

const prepared = fakePrepared({ durationSec: 24, spans: [{ start: 1, end: 6.5 }, { start: 8, end: 13.5, vibrato: true }, { start: 16, end: 22 }] });
const analysis = prepared.analysis;
const initial = (): SegPhrase[] => segmentPhrases(analysis);

interface Harness {
  latest: () => SegPhrase[];
  selected: () => number | null;
  changes: SegPhrase[][];
}

function mount(extra: Partial<PhraseEditorProps> = {}, start: SegPhrase[] = initial()): Harness {
  const changes: SegPhrase[][] = [];
  let latest = start;
  let sel: number | null = null;
  function Wrapper() {
    const [phrases, setPhrases] = useState(start);
    return (
      <PhraseEditor
        duration={prepared.durationSec}
        phrases={phrases}
        onChange={(next) => {
          latest = next;
          changes.push(next);
          setPhrases(next);
        }}
        samples={prepared.samples}
        analysis={analysis}
        onSelect={(i) => (sel = i)}
        {...extra}
      />
    );
  }
  act(() => root.render(<Wrapper />));
  return { latest: () => latest, selected: () => sel, changes };
}

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = container.querySelector<T>(sel);
  if (!el) throw new Error(`Nothing matches ${sel}`);
  return el;
};
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(container.querySelectorAll<T>(sel));
const button = (text: RegExp): HTMLButtonElement => {
  const b = $$<HTMLButtonElement>('button').find((el) => text.test(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`));
  if (!b) throw new Error(`No button matching ${text}`);
  return b;
};
const click = (el: Element) => act(() => (el as HTMLElement).click());
const handle = (edge: 'start' | 'end') => $<HTMLElement>(`.pe-handle--${edge}`);

/** Pixels per second the strip is drawn at, read from the first band. */
function pps(phrases = initial()): number {
  const w = Number($$('rect[data-band]')[0].getAttribute('width'));
  return w / (phrases[0].end - phrases[0].start);
}

/** Make the strip report a position so taps and drags can be mapped to times. */
function stubStripRect() {
  $<SVGSVGElement>('svg.pe-svg').getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
}

function tapStripAt(sec: number) {
  stubStripRect();
  const x = sec * pps();
  act(() => {
    $<SVGSVGElement>('svg.pe-svg').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x }));
  });
}

describe('pure helpers', () => {
  it('formats edge times to a tenth of a second', () => {
    expect(formatEdgeTime(0)).toBe('0:00.0');
    expect(formatEdgeTime(65.34)).toBe('1:05.3');
    expect(formatEdgeTime(9.96)).toBe('0:10.0');
    expect(formatEdgeTime(-1)).toBe('0:00.0');
    expect(formatEdgeTime(NaN)).toBe('0:00.0');
  });

  it('finds the phrase window under a time', () => {
    const list = initial();
    expect(bandAt(list, list[1].start + 0.1)).toBe(1);
    expect(bandAt(list, list[0].start - 0.05)).toBe(-1);
    expect(bandAt(list, list[2].end)).toBe(-1);
  });

  it('draws the waveform as one closed path and the pitch line as separate pieces', () => {
    const d = waveformPath(prepared.samples, 24, 600, 80, 30);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect((d.match(/M/g) ?? []).length).toBe(1);
    expect(waveformPath(new Float32Array(0), 24, 600, 80, 30)).toBe('');
    expect(waveformPath(prepared.samples, 0, 600, 80, 30)).toBe('');
    const lines = contourLines(analysis, 32, 20, 100);
    expect(lines.length).toBeGreaterThanOrEqual(3); // at least one piece per sung stretch
    for (const l of lines) for (const pt of l.split(' ')) expect(Number(pt.split(',')[1])).toBeGreaterThanOrEqual(20);
    expect(contourLines(analysisFromSpans([], 5), 32, 0, 100)).toEqual([]);
  });
});

describe('PhraseEditor', () => {
  it('draws a band and a list row for every phrase, with note range, length and a difficulty hint', () => {
    mount();
    expect($$('rect[data-band]')).toHaveLength(3);
    expect($$('.pe-item')).toHaveLength(3);
    const first = $$('.pe-item')[0].textContent ?? '';
    expect(first).toMatch(/0:00 to 0:06/);
    expect(first).toMatch(/5\.5 s/);
    expect($$('.pe-level').length).toBe(3);
    expect($$('.pe-level').some((el) => /Easy|Medium|Hard/.test(el.textContent ?? ''))).toBe(true);
    expect($('.pe-wave')).toBeTruthy();
    expect($$('.pe-contour').length).toBeGreaterThan(0);
    // The first phrase is selected and has its two handles.
    expect($$('.pe-item')[0].getAttribute('aria-current')).toBe('true');
    expect(handle('start').getAttribute('aria-label')).toBe('Phrase 1 start');
    expect(handle('end').getAttribute('aria-label')).toBe('Phrase 1 end');
  });

  it('works without a waveform or an analysis', () => {
    mount({ samples: null, analysis: null });
    expect($$('.pe-wave')).toHaveLength(0);
    expect($$('.pe-contour')).toHaveLength(0);
    expect($$('.pe-level')).toHaveLength(0);
    expect($$('.pe-item')).toHaveLength(3);
  });

  it('says what to do when there are no phrases', () => {
    mount({}, []);
    expect(container.textContent).toMatch(/No phrases were found.*pick a clip with a clearly sung melody/);
    expect($$('button')).toHaveLength(0);
  });

  it('selects from the list, and with Previous and Next', () => {
    const h = mount();
    click($$('.pe-item')[2]);
    expect(h.selected()).toBe(2);
    expect(handle('start').getAttribute('aria-label')).toBe('Phrase 3 start');
    expect(button(/Next phrase/).disabled).toBe(true);
    click(button(/Previous phrase/));
    expect(h.selected()).toBe(1);
    expect($$('.pe-item')[1].getAttribute('aria-current')).toBe('true');
    click(button(/Previous phrase/));
    expect(button(/Previous phrase/).disabled).toBe(true);
  });

  it('selects the phrase under a tap on the strip and puts the cursor there', () => {
    const h = mount();
    const list = initial();
    tapStripAt(list[1].start + 2);
    expect(h.selected()).toBe(1);
    expect($('.pe-cursor').getAttribute('x1')).toBe(String((list[1].start + 2) * pps()));
    // A tap between phrases moves the cursor but keeps the selection.
    tapStripAt((list[1].end + list[2].start) / 2);
    expect(h.selected()).toBe(1);
  });

  it('splits the selected phrase at the cursor, and only when both halves stay long enough', () => {
    const h = mount();
    const list = initial();
    expect(button(/Split at cursor/).disabled).toBe(true);
    expect(container.textContent).toMatch(/To split, tap the strip/);
    tapStripAt(list[0].start + 0.3); // too close to the start
    expect(button(/Split at cursor/).disabled).toBe(true);
    tapStripAt(list[0].start + 3);
    expect(button(/Split at cursor/).disabled).toBe(false);
    expect(container.textContent).toMatch(/Split cuts the phrase there/);
    click(button(/Split at cursor/));
    expect(h.latest()).toHaveLength(4);
    expect(h.latest()[0].end).toBeCloseTo(list[0].start + 3, 6);
    expect(h.latest()[1].start).toBeCloseTo(list[0].start + 3, 6);
    expect(h.latest().every((p) => p.voicedEnd >= p.voicedStart)).toBe(true);
    expect($$('.pe-item')).toHaveLength(4);
    expect($('[role="status"]').textContent).toMatch(/Split phrase 1 at 0:03\.\d\. There are now 4 phrases/);
  });

  it('merges the selected phrase with the next, and not the last one', () => {
    const h = mount();
    click(button(/Merge with next/));
    expect(h.latest()).toHaveLength(2);
    expect(h.latest()[0].end).toBe(initial()[1].end);
    expect($('[role="status"]').textContent).toMatch(/Merged phrases 1 and 2/);
    click($$('.pe-item')[1]);
    expect(button(/Merge with next/).disabled).toBe(true);
  });

  it('hides and shows a phrase, with the reason in words', () => {
    const h = mount();
    click(button(/Hide phrase/));
    expect(h.latest()[0].hidden).toBe(true);
    expect($$('rect[data-band]')[0].getAttribute('class')).toContain('pe-band--hidden');
    expect($$('.pe-item')[0].textContent).toMatch(/Hidden/);
    expect(container.textContent).toMatch(/will not be practised/);
    click(button(/Show phrase/));
    expect(h.latest()[0].hidden).toBe(false);
  });

  it('nudges an edge by 50 ms with the buttons', () => {
    const h = mount();
    const before = initial()[0];
    click(button(/Start 50 milliseconds later/));
    expect(h.latest()[0].start).toBeCloseTo(before.start + NUDGE_SEC, 6);
    click(button(/End 50 milliseconds earlier/));
    expect(h.latest()[0].end).toBeCloseTo(before.end - NUDGE_SEC, 6);
    expect(h.latest()[0].source).toBe('user');
    expect($('[role="status"]').textContent).toMatch(/Phrase 1 end is now/);
  });

  it('stops an edge at its neighbour and at the minimum length', () => {
    const h = mount();
    const list = initial();
    // Pull phrase 1's end far past phrase 2's start with repeated big nudges.
    for (let i = 0; i < 60; i++) act(() => handle('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })));
    expect(h.latest()[0].end).toBeLessThanOrEqual(list[1].start + 1e-9);
    for (let i = 0; i < 80; i++) act(() => handle('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true })));
    expect(h.latest()[0].end - h.latest()[0].start).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it('moves an edge with the arrow keys on its slider (Shift for 0.5 s) and ignores other keys', () => {
    const h = mount();
    const startEnd = initial()[0].end;
    expect(handle('end').getAttribute('role')).toBe('slider');
    expect(Number(handle('end').getAttribute('aria-valuenow'))).toBeCloseTo(startEnd, 6);
    act(() => handle('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(h.latest()[0].end).toBeCloseTo(startEnd + 0.05, 6);
    act(() => handle('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true })));
    expect(h.latest()[0].end).toBeCloseTo(startEnd - 0.45, 6);
    const n = h.changes.length;
    act(() => handle('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(h.changes.length).toBe(n);
    expect(handle('end').getAttribute('aria-valuetext')).toMatch(/seconds$/);
  });

  it('drags an edge to where the pointer goes', () => {
    const h = mount();
    stubStripRect();
    const target = initial()[0].end + 0.4;
    const x = target * pps();
    act(() => {
      handle('end').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: initial()[0].end * pps() }));
    });
    act(() => {
      handle('end').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x }));
    });
    expect(h.latest()[0].end).toBeCloseTo(target, 6);
    act(() => {
      handle('end').dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: x }));
    });
    expect($('[role="status"]').textContent).toMatch(/Phrase 1 end moved to 0:0\d\.\d/);
    // After the release, a move does nothing.
    const n = h.changes.length;
    act(() => {
      handle('end').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x + 100 }));
    });
    expect(h.changes.length).toBe(n);
  });

  it('zooms the strip in and out within its limits', () => {
    mount();
    const widthOf = () => Number($('svg.pe-svg').getAttribute('width'));
    const before = widthOf();
    click(button(/Zoom in/));
    expect(widthOf()).toBe(before * 2);
    click(button(/Zoom out/));
    click(button(/Zoom out/));
    expect(widthOf()).toBe(before / 2);
    for (let i = 0; i < ZOOM_LEVELS.length; i++) click(button(/Zoom out/));
    expect(button(/Zoom out/).disabled).toBe(true);
    for (let i = 0; i < ZOOM_LEVELS.length; i++) click(button(/Zoom in/));
    expect(button(/Zoom in/).disabled).toBe(true);
  });

  it('never draws the strip wider than the browser can comfortably hold, however long the clip', () => {
    const long = fakePrepared({ durationSec: 300, spans: [{ start: 1, end: 6.5 }, { start: 9, end: 14.5 }] });
    mount({ duration: 300, samples: long.samples, analysis: long.analysis }, segmentPhrases(long.analysis));
    for (let i = 0; i < ZOOM_LEVELS.length; i++) if (!button(/Zoom in/).disabled) click(button(/Zoom in/));
    expect(button(/Zoom in/).disabled).toBe(true);
    expect(Number($('svg.pe-svg').getAttribute('width'))).toBeLessThanOrEqual(24000);
    expect(Number($('svg.pe-svg').getAttribute('width'))).toBe(300 * 64);
  });

  it('dims what lies outside the part to keep', () => {
    mount({ trim: { startSec: 2, endSec: 20 } });
    expect($$('.pe-dim')).toHaveLength(2);
    expect(Number($$('.pe-dim')[0].getAttribute('width'))).toBeGreaterThan(0);
    act(() => root.render(<div />));
    mount({ trim: { startSec: 0, endSec: 24 } });
    expect($$('.pe-dim')).toHaveLength(0);
  });

  it('collapses short bits into a disclosure and opens it on request or when one is selected', () => {
    const list: SegPhrase[] = [
      { start: 0, end: 6, voicedStart: 0.2, voicedEnd: 5.8, fragment: false },
      { start: 6, end: 8, voicedStart: 6.5, voicedEnd: 7.1, fragment: true },
      { start: 8, end: 14, voicedStart: 8.2, voicedEnd: 13.8, fragment: false },
    ];
    mount({}, list);
    expect($$('.pe-item')).toHaveLength(2);
    const toggle = button(/Show 1 short bit/);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    click(toggle);
    expect($$('.pe-item')).toHaveLength(3);
    expect($$('.pe-item')[1].textContent).toMatch(/Short bit/);
    expect(button(/Hide 1 short bit/).getAttribute('aria-expanded')).toBe('true');
    // The strip band of a short bit is drawn as hidden.
    expect($$('rect[data-band]')[1].getAttribute('class')).toContain('pe-band--hidden');
  });

  it('plays the selected phrase and offers Stop; stopping at a point puts the cursor there', () => {
    const play = vi.fn();
    const stop = vi.fn();
    let playing = false;
    const list = initial();
    const props = (): Partial<PhraseEditorProps> => ({ onPlayPhrase: play, onStop: stop, playing, getPlayhead: () => list[0].start + 2.5 });
    const h = mount(props());
    click(button(/Play phrase 1/));
    expect(play).toHaveBeenCalledWith(0);
    playing = true;
    mount(props());
    click(button(/^Stop/));
    expect(stop).toHaveBeenCalledTimes(1);
    expect($('.pe-cursor').getAttribute('x1')).toBe(String((list[0].start + 2.5) * pps()));
    expect(button(/Split at cursor/).disabled).toBe(false);
    expect(h.latest()).toHaveLength(3);
  });

  it('hides the play button when nothing can play', () => {
    mount();
    expect($$('button').some((b) => /Play phrase/.test(b.textContent ?? ''))).toBe(false);
  });

  it('moves the playhead on animation frames while playing, and hides it otherwise', () => {
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => (pending.set(nextId, cb), nextId++));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
    const flush = () => {
      const due = [...pending.values()];
      pending.clear();
      act(() => due.forEach((cb) => cb(0)));
    };
    let t: number | null = 3;
    mount({ playing: true, getPlayhead: () => t, onPlayPhrase: () => undefined });
    expect(pending.size).toBe(1); // one loop, however often the strip re-rendered
    flush();
    const line = $('.pe-playhead');
    expect(line.getAttribute('visibility')).toBe('visible');
    expect(line.getAttribute('x1')).toBe(String(3 * pps()));
    expect(line.getAttribute('x2')).toBe(String(3 * pps()));
    t = null;
    flush();
    expect(line.getAttribute('visibility')).toBe('hidden');
    // The loop keeps going until the editor unmounts, then stops.
    expect(pending.size).toBe(1);
    act(() => root.render(<div />));
    expect(pending.size).toBe(0);
  });

  it('keeps working when the selection is controlled by the parent', () => {
    const onSelect = vi.fn();
    mount({ selected: 2, onSelect });
    expect(handle('start').getAttribute('aria-label')).toBe('Phrase 3 start');
    click($$('.pe-item')[0]);
    expect(onSelect).toHaveBeenCalledWith(0);
    // The parent did not change `selected`, so the editor still shows phrase 3.
    expect(handle('start').getAttribute('aria-label')).toBe('Phrase 3 start');
  });

  it('shows a hint instead of a toolbar when nothing is selected', () => {
    mount({ selected: null });
    expect(container.textContent).toMatch(/Tap a phrase on the strip or in the list to edit it/);
    expect($$('.pe-handle')).toHaveLength(0);
    expect($$('button').some((b) => /Split at cursor/.test(b.textContent ?? ''))).toBe(false);
  });

  it('gives every control a touch target of at least 44px in its class (checked in the stylesheet source)', () => {
    // jsdom has no layout, so the stylesheet is checked as text: the handle, the list rows and the nudge buttons.
    const css = readFileSync(join(import.meta.dirname, 'clipImport.css'), 'utf8');
    expect(css).toMatch(/\.pe-handle\s*\{[^}]*width:\s*44px/);
    expect(css).toMatch(/\.pe-item\s*\{[^}]*min-height:\s*52px/);
    expect(css).toMatch(/\.icon-button--touch\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  });
});
