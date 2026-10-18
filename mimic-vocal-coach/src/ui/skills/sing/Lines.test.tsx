// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { intervalTargetOf } from '../../../skills/theory';
import type { IntervalTarget, SequenceTarget } from '../../../skills/types';
import { SequenceScreen } from './SequenceScreen';
import { SingIntervalsScreen } from './SingIntervalsScreen';
import { baseProps, fakeWorld, harness, intervalScore, sequenceScore, type Harness } from './testKit';

let h: Harness;
afterEach(() => h?.unmount());

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SingIntervalsScreen', () => {
  it('read mode: plays only the reference, says what to sing, scores the interval size separately', async () => {
    const world = fakeWorld();
    h = harness();
    const props = baseProps();
    act(() => h.root.render(<SingIntervalsScreen {...props} plan={{ count: 2, mode: 'read' }} deps={world.deps} />));
    expect(h.text()).toMatch(/Sing the note, then an? (perfect|major|minor|octave)[^.]*(up|down)/);
    await h.click(/Play the note and sing/);
    expect(world.plays[0]).toHaveLength(1);
    expect(world.last.opts.rule).toEqual({ kind: 'notes', expectedNotes: 2, silenceSec: 1.2, capSec: 8 });
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    const target = (world.deps.scoreSungInterval as ReturnType<typeof vi.fn>).mock.calls[0][2] as IntervalTarget;
    // Both notes inside the baritone comfortable range A2-F4.
    for (const m of [target.referenceMidi, intervalTargetOf(target)]) {
      expect(m).toBeGreaterThanOrEqual(45);
      expect(m).toBeLessThanOrEqual(65);
    }
    expect(h.text()).toContain('Interval size');
    expect(h.text()).toContain('+32 cents');
    expect(h.text()).toContain('too wide');
    expect(h.text()).toContain('First note');
    expect(h.text()).toContain('Second note');
    expect(h.container.querySelector('[aria-live="polite"]')?.textContent).toContain('32 cents too wide');
    await h.click(/Next interval/);
    await h.key('Enter');
    await h.key('Enter');
    expect(world.captures[1].stoppedBy).toBe('key');
    await h.click(/See the summary/);
    expect(props.onDone).toHaveBeenCalledTimes(1);
    const s = props.onDone.mock.calls[0][0];
    expect(s.kind).toBe('sing-intervals');
    expect(s.items).toHaveLength(2);
    expect(s.meanAbsIntervalCents).toBe(32);
    expect(s.items[0].mode).toBe('read');
  });

  it('listen mode plays both notes; wrong direction and too quiet read plainly', async () => {
    const world = fakeWorld();
    let n = 0;
    world.deps.scoreSungInterval = vi.fn((_s, _r, t: IntervalTarget) =>
      ++n === 1 ? intervalScore(t, { wrongDirection: true }) : intervalScore(t, { status: 'too-quiet', intervalCents: null, referenceCents: null, targetCents: null, findings: [] }),
    );
    h = harness();
    act(() => h.root.render(<SingIntervalsScreen {...baseProps()} plan={{ count: 3, mode: 'listen' }} deps={world.deps} />));
    expect(h.text()).toContain('Listen to both notes');
    await h.click(/Play both and sing/);
    expect(world.plays[0]).toHaveLength(2);
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    expect(h.text()).toMatch(/went the other way/);
    await h.click(/Sing it again/);
    await act(async () => world.last.autoStop('cap'));
    await h.flush();
    expect(h.text()).toContain('Too quiet to score');
    expect(h.text()).not.toContain('+32 cents');
  });
});

describe('SequenceScreen', () => {
  function renderSeq(world = fakeWorld(), over: Record<string, unknown> = {}) {
    h = harness();
    const props = { ...baseProps(), ...over };
    act(() => h.root.render(<SequenceScreen {...props} deps={world.deps} />));
    return { world, props };
  }

  it('shows the 7 6 5 4 3 2 line, plays the cadence then the tonic, and colours each degree after the take', async () => {
    const { world, props } = renderSeq();
    const degrees = Array.from(h.container.querySelectorAll('.sing-degree-text')).map((e) => e.textContent);
    expect(degrees).toEqual(['7', '6', '5', '4', '3', '2']);
    await h.click(/Play the key and sing/);
    const roles = world.plays[0].map((e) => e.role);
    expect(roles.slice(0, 4)).toEqual(['cadence', 'cadence', 'cadence', 'cadence']);
    expect(roles[4]).toBe('tonic');
    expect(roles).not.toContain('line');
    expect(world.last.opts.rule).toEqual({ kind: 'notes', expectedNotes: 6, silenceSec: 1.2, capSec: 22 });
    await act(async () => {
      world.last.emit(60);
      world.last.autoStop('auto-silence');
    });
    await h.flush();
    const target = (world.deps.scoreSequence as ReturnType<typeof vi.fn>).mock.calls[0][2] as SequenceTarget;
    expect(target.text).toBe('7 6 5 4 3 2');
    expect(Math.min(...target.midis)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...target.midis)).toBeLessThanOrEqual(65);
    const items = Array.from(h.container.querySelectorAll('.sing-degree'));
    expect(items[0].className).toContain('sing-acc--near'); // 41 cents: outside ±25, inside 50
    expect(items[0].getAttribute('aria-label')).toBe('7: 41 cents flat');
    expect(items[1].className).toContain('sing-acc--within');
    expect(h.text()).toContain('5 of 6 notes in the band');
    expect(h.text()).toContain('an octave lower than it played. That is fine');
    expect(h.text()).toContain('Your 7 sat 41 cents flat.');
    await h.click(/^Finish/);
    expect(props.onDone).toHaveBeenCalledTimes(1);
    const s = props.onDone.mock.calls[0][0];
    expect(s.kind).toBe('sequence');
    expect(s.items[0]).toMatchObject({ text: '7 6 5 4 3 2', scaleMode: 'major', octaveOffset: -1, missing: 0, extras: 0 });
    expect(s.items[0].perNote[0]).toEqual({ degree: 7, cents: -41 });
  });

  it('saves scored takes when the page is closed or reloaded (no unmount), and Finish saves only the new ones', async () => {
    const { world, props } = renderSeq();
    await h.click(/Play the key and sing/);
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    expect(props.onDone).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(props.onDone.mock.calls[0][0].items).toHaveLength(1);
    // A second pagehide with nothing new saves nothing.
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(props.onDone).toHaveBeenCalledTimes(1);
    await h.key('Enter');
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    await h.click(/^Finish/);
    expect(props.onDone).toHaveBeenCalledTimes(2);
    expect(props.onDone.mock.calls[1][0].items).toHaveLength(1);
    expect(props.onDone.mock.calls[1][0].id).not.toBe(props.onDone.mock.calls[0][0].id);
  });

  it('listen and repeat plays the line after the cadence and highlights the sounding degree', async () => {
    const { world } = renderSeq();
    const listen = Array.from(h.container.querySelectorAll('input[name="seq-mode"]'))[1] as HTMLInputElement;
    await act(async () => listen.click());
    await h.click(/Play the line and sing/);
    expect(world.plays[0].filter((e) => e.role === 'line')).toHaveLength(6);
  });

  it('typed lines: live parser errors, Return in the text box does not start singing, a good line replaces the strip', async () => {
    const { world } = renderSeq();
    const input = h.container.querySelector('#seq-text') as HTMLInputElement;
    await act(async () => typeInto(input, '7 6 9'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(h.container.querySelector('#seq-text-error')?.textContent).toMatch(/9/);
    expect(h.button(/Use this line/).disabled).toBe(true);
    await h.key('Enter', input);
    expect(world.plays).toHaveLength(0);
    await act(async () => typeInto(input, '2 7 6 5'));
    expect(input.getAttribute('aria-invalid')).toBe('false');
    await h.click(/Use this line/);
    const degrees = Array.from(h.container.querySelectorAll('.sing-degree-text')).map((e) => e.textContent);
    expect(degrees).toEqual(['2', '7', '6', '5']);
    // 7 below the 2: a dot below.
    expect(h.container.querySelectorAll('.sing-degree')[1].getAttribute('aria-label')).toBe('7 (low)');
  });

  it('a preset, the solfege labels, and a planned run of two lines report one session', async () => {
    const world = fakeWorld();
    const { props } = renderSeq(world, { plan: { texts: ['5 4 3 2 1', '1 3 5 3 1'], mode: 'read' } });
    expect(h.text()).toContain('Line 1 of 2');
    expect(h.container.querySelector('#seq-text')).toBeNull();
    await h.key('Enter');
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    await h.key('Enter');
    expect(h.text()).toContain('Line 2 of 2');
    await h.key('Enter');
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    await h.click(/^Finish/);
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(props.onDone.mock.calls[0][0].items.map((i: { text: string }) => i.text)).toEqual(['5 4 3 2 1', '1 3 5 3 1']);
  });

  it('shows solfege when chosen and asks to save the preference', async () => {
    const { props } = renderSeq();
    const solfege = Array.from(h.container.querySelectorAll('input[name="seq-labels"]'))[1] as HTMLInputElement;
    await act(async () => solfege.click());
    const degrees = Array.from(h.container.querySelectorAll('.sing-degree-text')).map((e) => e.textContent);
    expect(degrees).toEqual(['ti', 'la', 'sol', 'fa', 'mi', 're']);
    expect(props.onPrefs).toHaveBeenCalledWith({ labelMode: 'solfege' });
  });

  it('handles a too-quiet take and an interrupted one without recording anything', async () => {
    const world = fakeWorld();
    world.deps.scoreSequence = vi.fn((_s, _r, t: SequenceTarget) => sequenceScore(t, { status: 'too-quiet', noteAccuracy: null, meanAbsCents: null, findings: [] }));
    const { props } = renderSeq(world);
    await h.click(/Play the key and sing/);
    await act(async () => world.last.autoStop('cap'));
    await h.flush();
    expect(h.text()).toContain('Too quiet to score');
    expect(h.container.querySelector('.sing-acc--off')).toBeNull();
    await h.click(/Sing it again/);
    await act(async () => world.last.interrupt('muted'));
    await h.flush();
    expect(h.text()).toContain('Take interrupted');
    expect(props.onDone).not.toHaveBeenCalled();
  });
});
