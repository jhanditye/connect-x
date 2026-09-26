// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAnalysis } from '../../testing/fixtures';
import { PitchPlot, readoutHint } from './PitchPlot';

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
  vi.restoreAllMocks();
});

function plot(): SVGSVGElement {
  return container.querySelector<SVGSVGElement>('.pitchplot-scroll svg')!;
}
function readout(): string {
  return container.querySelector('.pitchplot-readout')?.textContent ?? '';
}
function pointer(type: string, pointerType: string, clientX: number) {
  act(() => {
    plot().dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType, clientX, clientY: 100, relatedTarget: type === 'pointerout' ? document.body : null }));
  });
}

describe('PitchPlot readout', () => {
  it('a tap on a touch screen shows the note and keeps it after the finger lifts', () => {
    act(() => root.render(<PitchPlot analysis={makeFakeAnalysis()} />));
    expect(readout()).toMatch(/touch the plot/i);
    // A tap fires pointerdown, pointerup and pointerleave with no pointermove.
    pointer('pointerdown', 'touch', 200);
    const value = readout();
    expect(value).toMatch(/^\d+\.\d\d s · /);
    pointer('pointerup', 'touch', 200);
    pointer('pointerout', 'touch', 200);
    expect(readout()).toBe(value);
    // A sideways drag scrubs.
    pointer('pointermove', 'touch', 400);
    expect(readout()).not.toBe(value);
    expect(readout()).toMatch(/^\d+\.\d\d s · /);
  });

  it('mouse hover follows the pointer and clears when it leaves', () => {
    act(() => root.render(<PitchPlot analysis={makeFakeAnalysis()} />));
    pointer('pointermove', 'mouse', 200);
    expect(readout()).toMatch(/^\d+\.\d\d s · /);
    pointer('pointerout', 'mouse', 200);
    expect(readout()).toMatch(/hover over or touch the plot/i);
  });

  it('uses a shorter hint on narrow screens', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 328, height: 300, x: 0, y: 0, top: 0, left: 0, right: 328, bottom: 300, toJSON() {} } as DOMRect);
    act(() => root.render(<PitchPlot analysis={makeFakeAnalysis()} />));
    expect(readout()).toBe('Touch the plot to read the note and register.');
    expect(readoutHint(288)).toBe('Touch the plot to read a note.');
    expect(readoutHint(976)).toMatch(/^Hover over or touch/);
  });
});
