// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExercise } from '../../coach/exercises';
import { COMPARISON_SCENARIOS, makeFakePhraseComparison } from '../../testing/trainerFixtures';
import { buildFixes } from '../../trainer/feedback';
import { FixCard, FixList } from './FixCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixesOf = (s: Parameters<typeof makeFakePhraseComparison>[0]) => buildFixes(makeFakePhraseComparison(s, { shift: -12 }), 'daniel');

describe('FixList (server markup)', () => {
  it('shows each fix as a coaching card with what we heard, why it matters and how to fix it', () => {
    const h = renderToStaticMarkup(<FixList fixes={fixesOf('flat')} onOpenExercises={() => undefined} onLoop={() => undefined} />);
    expect((h.match(/<article class="coach-card /g) ?? []).length).toBe(2);
    expect(h).toContain('Lift the flat notes');
    expect(h).toContain('Add the vibrato');
    expect(h).toContain('Work on first');
    expect(h).toContain('>Next<');
    expect(h).toContain('What we heard');
    expect(h).toContain('How to fix it');
    expect(h).toMatch(/worth about 4(\.1)? points?/);
    expect(h).toContain('Pitch');
    expect(h).toContain('Tone and shaping');
    expect(h).not.toContain('NaN');
  });

  it('links to the suggested exercises by name and adds the slow loop of the weak region', () => {
    const h = renderToStaticMarkup(<FixList fixes={fixesOf('flat')} onOpenExercises={() => undefined} onLoop={() => undefined} />);
    expect(h).toContain(getExercise('drone-tuning')?.name);
    expect(h).toMatch(/Loop \d+\.\d–\d+\.\d s at 75%/);
  });

  it('leaves the loop button out when the screen cannot loop', () => {
    const h = renderToStaticMarkup(<FixList fixes={fixesOf('flat')} onOpenExercises={() => undefined} />);
    expect(h).not.toContain('Loop ');
  });

  it('shows at most three cards', () => {
    const f = fixesOf('flat')[0];
    const many = [f, { ...f, id: 'a' }, { ...f, id: 'b' }, { ...f, id: 'c' }];
    expect((renderToStaticMarkup(<FixList fixes={many} onOpenExercises={() => undefined} />).match(/<article class="coach-card /g) ?? []).length).toBe(3);
  });

  it('an empty list says what to do next, with a different line when told why', () => {
    expect(renderToStaticMarkup(<FixList fixes={[]} onOpenExercises={() => undefined} />)).toMatch(/Nothing stood out to fix\. Try it again at full speed, or move on to the next phrase\./);
    expect(renderToStaticMarkup(<FixList fixes={[]} emptyText="Sing the phrase again." onOpenExercises={() => undefined} />)).toContain('Sing the phrase again.');
  });

  it('every scenario renders without a missing exercise or a crash', () => {
    for (const s of COMPARISON_SCENARIOS) {
      const h = renderToStaticMarkup(<FixList fixes={fixesOf(s)} onOpenExercises={() => undefined} onLoop={() => undefined} />);
      expect(h, s).not.toContain('undefined');
    }
  });

  it('exercise ids the library does not know are left out instead of breaking the card', () => {
    const f = { ...fixesOf('flat')[0], exerciseIds: ['no-such-exercise', 'drone-tuning'] };
    const h = renderToStaticMarkup(<FixCard fix={f} onOpenExercises={() => undefined} />);
    expect(h).toContain(getExercise('drone-tuning')?.name);
    expect(h).not.toContain('no-such-exercise');
  });
});

describe('FixCard (interaction)', () => {
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

  it('the loop button hands the region and the fix to the screen; the exercise link opens that exercise', () => {
    const onLoop = vi.fn();
    const onOpen = vi.fn();
    const [fix] = fixesOf('flat');
    act(() => root.render(<FixCard fix={fix} onLoop={onLoop} onOpenExercises={onOpen} />));
    const loop = container.querySelector('button.fc-loop') as HTMLButtonElement;
    expect(loop.textContent).toMatch(/Loop \d+\.\d–\d+\.\d s at 75%/);
    act(() => loop.click());
    expect(onLoop).toHaveBeenCalledWith(fix.loop, fix);
    const link = container.querySelector('button.link-button') as HTMLButtonElement;
    expect(link.textContent).toBe(getExercise('drone-tuning')?.name);
    act(() => link.click());
    expect(onOpen).toHaveBeenCalledWith(['drone-tuning']);
  });
});
