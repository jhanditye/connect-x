// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeFakeProfile } from '../../testing/fixtures';
import { FAKE_NOW, makeFakeClip } from '../../testing/trainerFixtures';
import { ClipCard, clipColor } from './ClipCard';

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

const render = (node: React.ReactNode) => act(() => root.render(node));
const shawn = makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', color: '#b97a12' });

describe('ClipCard', () => {
  it('is one link to the clip, with title, length, phrase count and what is mastered', () => {
    render(<ClipCard clip={makeFakeClip({ id: 'a b', title: 'Treat You Better, verse' })} singer={shawn} now={FAKE_NOW} />);
    const a = container.querySelector('a.cc') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('#trainer/c/a%20b');
    expect(a.textContent).toContain('Treat You Better, verse');
    expect(a.textContent).toContain('12 phrases');
    expect(a.textContent).toContain('1:24');
    expect(a.textContent).toContain('4 of 12 mastered, 6 in progress');
    expect(a.textContent).toContain('3 to review');
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('draws the progress bar as decoration and gives the same news in words', () => {
    render(<ClipCard clip={makeFakeClip()} singer={shawn} now={FAKE_NOW} />);
    const bar = container.querySelector('.cc-bar');
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    const style = (container.querySelector('a.cc') as HTMLElement).style;
    expect(style.getPropertyValue('--done')).toBe(`${(4 / 12) * 100}%`);
    expect(style.getPropertyValue('--doing')).toBe(`${(10 / 12) * 100}%`);
  });

  it('flags a full song and a clip that needs its audio again, and says what to do', () => {
    render(<ClipCard clip={makeFakeClip({ kind: 'mix' })} singer={shawn} now={FAKE_NOW} />);
    expect(container.textContent).toContain('Full song');
    render(<ClipCard clip={makeFakeClip({ audioMissing: true })} singer={shawn} now={FAKE_NOW} />);
    expect(container.textContent).toContain('Needs the file again');
    expect(container.querySelector('.cc-bar')).toBeNull();
  });

  it('copes with a clip with no phrases and one phrase', () => {
    const none = makeFakeClip({ phrases: [] });
    render(<ClipCard clip={none} singer={null} now={FAKE_NOW} />);
    expect(container.textContent).toContain('0 phrases');
    expect(container.textContent).toContain('No phrases yet');
    const one = makeFakeClip();
    render(<ClipCard clip={{ ...one, phrases: [one.phrases[11]] }} singer={null} now={FAKE_NOW} />);
    expect(container.textContent).toContain('1 phrase ');
    expect(container.textContent).toContain('0 of 1 mastered');
  });

  it('uses the singer token for a builtin singer and the custom colour for someone else', () => {
    expect(clipColor(shawn)).toBe('var(--singer-shawn)');
    expect(clipColor(null)).toBe('var(--singer-custom)');
  });
});
