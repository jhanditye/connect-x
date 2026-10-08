// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Spark } from './Spark';
import { StatusChip } from './StatusChip';

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

describe('Spark', () => {
  it('draws up to the last five scores as dots, joined by a line, and says the numbers in its name', () => {
    act(() => root.render(<Spark scores={[50, 60, 70, 80, 90, 99]} />));
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-label')).toBe('Last 5 scores: 60, 70, 80, 90, 99');
    expect(container.querySelectorAll('circle')).toHaveLength(5);
    expect(container.querySelectorAll('.spark-dot--last')).toHaveLength(1);
    expect(container.querySelector('polyline')).not.toBeNull();
    expect(svg.getAttribute('role')).toBe('img');
  });

  it('puts higher scores higher up', () => {
    act(() => root.render(<Spark scores={[20, 90]} />));
    const [a, b] = Array.from(container.querySelectorAll('circle')).map((c) => Number(c.getAttribute('cy')));
    expect(b).toBeLessThan(a);
  });

  it('one score is one dot and no line; none, or only nonsense, draws nothing', () => {
    act(() => root.render(<Spark scores={[72]} />));
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('polyline')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('Last score: 72');
    act(() => root.render(<Spark scores={[]} />));
    expect(container.innerHTML).toBe('');
    act(() => root.render(<Spark scores={[Number.NaN]} />));
    expect(container.innerHTML).toBe('');
  });

  it('keeps a score outside 0..100 on the chart', () => {
    act(() => root.render(<Spark scores={[-10, 140]} />));
    for (const c of Array.from(container.querySelectorAll('circle'))) {
      const cy = Number(c.getAttribute('cy'));
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(20);
    }
  });
});

describe('StatusChip', () => {
  it('says the status in words, with the hint as its title', () => {
    act(() => root.render(<StatusChip status="review-due" />));
    const chip = container.querySelector('.sc') as HTMLElement;
    expect(chip.textContent).toBe('Review due');
    expect(chip.className).toContain('sc--review-due');
    expect(chip.title).toMatch(/due for a review today/);
    act(() => root.render(<StatusChip status="stuck" className="x" />));
    expect(container.querySelector('.sc')?.textContent).toBe('Stuck');
    expect(container.querySelector('.sc')?.className).toContain('x');
  });
});
