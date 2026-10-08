// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeFakeClip, makeFakeTrainerController } from '../../testing/trainerFixtures';
import { useScreen } from '../../testing/trainerUi';
import type { MeasuredClip } from '../../types';
import { MeasurePanel, type MeasurePanelProps } from './MeasurePanel';

const screen = useScreen();

const measured = (id: string): MeasuredClip => ({ id, name: id, addedAt: '2026-10-01T00:00:00Z', durationSec: 30, voicedSec: 20, style: {} as MeasuredClip['style'], pitch: { lowMidi: 50, highMidi: 70, tessituraLowMidi: 55, tessituraHighMidi: 65 } });

function panel(props: Partial<MeasurePanelProps> = {}, clips = [makeFakeClip()]) {
  const ctl = makeFakeTrainerController({ clips });
  const fns = { onMeasure: vi.fn(async () => ({ added: 0, rejected: [] })), onRemove: vi.fn(), onClear: vi.fn() };
  screen.mount(<MeasurePanel singerId="shawn-mendes" singerName="Shawn Mendes" clips={[]} trainer={ctl} {...fns} {...props} />, ctl);
  return { ctl, ...fns };
}

describe('MeasurePanel with the Trainer', () => {
  it('becomes "Add clips to the Trainer" with a link to the add sheet', () => {
    panel();
    expect(screen.q('#measure-heading').textContent).toBe('Add clips to the Trainer');
    expect(screen.link(/Add clips in the Trainer/).getAttribute('href')).toBe('#trainer/add');
    expect(screen.text()).toMatch(/Only the numbers are used, never the audio/);
  });

  it('lists the singer\'s clips with a one-tap switch each, and the clips of other singers stay out', async () => {
    const other = makeFakeClip({ id: 'other', title: 'Daniel clip', singerId: 'daniel-caesar' });
    const { ctl } = panel({}, [makeFakeClip(), other]);
    expect(screen.qa('.mt-clip')).toHaveLength(1);
    expect(screen.q('.mt-clip-name').textContent).toBe('Fake clip, 12 phrases');
    expect(screen.q('.mt-clip-name').getAttribute('href')).toBe('#trainer/c/fake-clip');
    expect(screen.q('.mt-clip-meta').textContent).toBe('12 phrases · solo vocal');
    const sw = screen.q<HTMLInputElement>('.mt-clip input[role="switch"]');
    expect(sw.checked).toBe(false);
    await screen.clickAsync(sw);
    expect(ctl.clips.find((c) => c.id === 'fake-clip')?.contributesToSinger).toBe(true);
    expect(screen.q('[role="status"].visually-hidden').textContent).toMatch(/now counts toward Shawn's targets/);
    expect(screen.text()).toMatch(/1 clip counts toward Shawn's targets/);
  });

  it('"Use all usable clips" turns on every clip that can count, in one tap', async () => {
    const a = makeFakeClip({ id: 'a', title: 'A' });
    const b = makeFakeClip({ id: 'b', title: 'B' });
    const mix = makeFakeClip({ id: 'c', title: 'C mix', kind: 'mix' });
    const { ctl } = panel({}, [a, b, mix]);
    await screen.clickAsync(screen.button(/Use all 2 usable clips for Shawn's targets/));
    expect(ctl.clips.filter((c) => c.contributesToSinger).map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(screen.hasButton(/Use all/)).toBe(false);
    expect(screen.q('[role="status"].visually-hidden').textContent).toBe("2 clips now count toward Shawn's targets.");
  });

  it('a clip that cannot count has its switch off with the reason beside it', () => {
    panel({}, [makeFakeClip({ id: 'm', title: 'Mix', kind: 'mix' })]);
    expect(screen.q<HTMLInputElement>('.mt-clip input[role="switch"]').disabled).toBe(true);
    expect(screen.q('.mt-clip .field-hint').textContent).toMatch(/full song mix cannot set a singer's targets/);
    expect(screen.hasButton(/Use all|Use this clip/)).toBe(false);
  });

  it('says so, with the next step, when the singer has no clips yet', () => {
    panel({}, []);
    expect(screen.text()).toMatch(/No clips of Shawn in the Trainer yet\. Add one and it will be listed here\./);
  });

  it('shows what the library refused', async () => {
    const { ctl } = panel();
    ctl.setContributes = async () => {
      throw new Error('Singer targets are not available here.');
    };
    await screen.clickAsync(screen.q('.mt-clip input[role="switch"]'));
    expect(screen.q('.field-error').textContent).toBe('Singer targets are not available here.');
  });

  it('keeps the numbers-only way under a fold, and it still measures files', async () => {
    const { onMeasure } = panel({ clips: [measured('legacy')] });
    const fold = screen.q<HTMLDetailsElement>('details.mt-legacy');
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')?.textContent).toBe('Measure numbers only, without keeping the clip');
    expect(fold.querySelector('#measure-numbers-heading')?.textContent).toBe('Measure Shawn from real recordings');
    expect(fold.textContent).toMatch(/The targets for Shawn now come from 1 clip you added/);
    const input = fold.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['x'], 'verse.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onMeasure).toHaveBeenCalledWith([file], expect.any(Function));
  });
});

describe('MeasurePanel without the Trainer', () => {
  it('is the numbers-only panel on its own, as it always was', () => {
    const ctl = makeFakeTrainerController();
    screen.mount(<MeasurePanel singerName="Shawn Mendes" clips={[]} onMeasure={vi.fn(async () => ({ added: 0, rejected: [] }))} onRemove={vi.fn()} onClear={vi.fn()} />, ctl);
    expect(screen.q('#measure-heading').textContent).toBe('Measure Shawn from real recordings');
    expect(screen.has('.mt-legacy')).toBe(false);
    expect(screen.qa('a').some((a) => /Add clips in the Trainer/.test(a.textContent ?? ''))).toBe(false);
  });
});
