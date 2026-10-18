// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BREATH_SAFETY_NOTES } from '../../../skills/theory';
import { BreathScreen } from './BreathScreen';
import { baseProps, fakeWorld, harness, hissScore, longToneScore, type Harness } from './testKit';

let h: Harness;
afterEach(() => {
  h?.unmount();
  vi.useRealTimers();
});

function renderBreath(world = fakeWorld(), over: Record<string, unknown> = {}) {
  h = harness();
  const props = { ...baseProps(), ...over };
  act(() => h.root.render(<BreathScreen {...props} deps={world.deps} />));
  return { world, props };
}

/** One count per act: each count's timer is scheduled after the previous count has rendered. */
async function counts(n: number) {
  for (let i = 0; i < n; i++) await act(async () => vi.advanceTimersByTime(1000));
}

function choose(part: number) {
  const r = Array.from(h.container.querySelectorAll('input[name="breath-part"]'))[part] as HTMLInputElement;
  act(() => r.click());
}

describe('BreathScreen', () => {
  it('always shows the safety notes', () => {
    renderBreath();
    for (const note of BREATH_SAFETY_NOTES) expect(h.text()).toContain(note);
    choose(1);
    expect(h.text()).toContain(BREATH_SAFETY_NOTES[0]);
  });

  it('paced breathing runs the guide count by count and records the rounds without the microphone', async () => {
    vi.useFakeTimers();
    const { world, props } = renderBreath(fakeWorld(), { plan: { parts: ['paced'], pacedRounds: 2 } });
    await h.click(/^Start/);
    expect(h.text()).toContain('Breathe in, low and wide');
    expect(h.text()).toContain('Round 1 of 2');
    // Round 1: 4 + 4 + 8 counts, then 8 counts of normal breathing (about two easy breaths).
    await counts(4);
    expect(h.text()).toContain('Suspend: a gentle pause, throat open');
    await counts(4);
    expect(h.text()).toContain('Out on a steady "sss"');
    await counts(8);
    expect(h.container.querySelector('.sing-breath-words')?.textContent).toBe('Breathe normally');
    await counts(4);
    expect(h.text()).toContain('Round 1 of 2');
    await counts(4);
    expect(h.text()).toContain('Round 2 of 2');
    expect(h.text()).toContain('out 10');
    await counts(4 + 4 + 10);
    expect(h.text()).toContain('2 rounds done');
    expect(h.text()).toContain('10 counts');
    expect(world.captures).toHaveLength(0);
    vi.useRealTimers();
    // Return now moves on (Done) instead of restarting the guide.
    expect(h.text()).toContain('Done (Return)');
    await h.key('Enter');
    expect(h.container.querySelector('.sing-breath')).toBeNull();
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(props.onDone.mock.calls[0][0]).toMatchObject({ kind: 'breath', paced: { rounds: 2, maxExhaleCounts: 10 }, hiss: null, longTone: null });
  });

  it('a stopped paced session keeps the rounds finished so far', async () => {
    vi.useFakeTimers();
    renderBreath(fakeWorld(), { plan: { parts: ['paced'], pacedRounds: 3 } });
    await h.click(/^Start/);
    await counts(25);
    await h.click(/^Stop/);
    expect(h.text()).toContain('1 round done');
  });

  it('Escape stops the guide, and the phase word shows inside the circle', async () => {
    vi.useFakeTimers();
    renderBreath(fakeWorld(), { plan: { parts: ['paced'], pacedRounds: 3 } });
    await h.click(/^Start/);
    expect(h.container.querySelector('.sing-breath-phase')?.textContent).toBe('In');
    await counts(4);
    expect(h.container.querySelector('.sing-breath-phase')?.textContent).toBe('Pause');
    await h.key('Escape');
    expect(h.container.querySelector('.sing-breath')).toBeNull();
    expect(h.text()).toContain('Start');
  });

  it('hiss test: no prompt, sustain rule, duration and steadiness, personal best', async () => {
    const { world, props } = renderBreath();
    choose(1);
    await h.click(/^Start/);
    expect(world.plays).toHaveLength(0);
    expect(world.last.opts.rule).toEqual({ kind: 'sustain', silenceSec: 0.8, capSec: 90 });
    await act(async () => world.last.emit(null, -30));
    expect(h.container.querySelector('.sing-level-fill')).not.toBeNull();
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    expect(h.text()).toContain('21.4 s of steady hiss');
    expect(h.text()).toContain('very steady');
    expect(h.text()).toContain('longest so far (was 18.0 s); only worth it if it felt easy');
    await h.click(/^Done/);
    expect(props.onDone.mock.calls[0][0].hiss).toEqual({ status: 'ok', durationSec: 21.4, steadinessDb: 1.2 });
  });

  it('a sung note in the hiss test is not counted as a hiss', async () => {
    const world = fakeWorld({ scoreHiss: vi.fn(() => hissScore({ status: 'voiced', durationSec: 0, steadinessDb: null })) });
    const { props } = renderBreath(world);
    choose(1);
    await h.click(/^Start/);
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    expect(h.text()).toContain('sounded like a sung or spoken note');
    await h.click(/^Done/);
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('long tone: plays the middle note first, then scores length and steadiness; Return stops', async () => {
    const world = fakeWorld({ scoreLongTone: vi.fn(() => longToneScore()) });
    renderBreath(world);
    choose(2);
    await h.key('Enter');
    expect(world.plays[0]).toHaveLength(1);
    // Baritone A2-F4 (45-65): 40 % up is F3 (53).
    expect(world.plays[0][0].midis[0]).toBe(53);
    expect(world.last.opts.rule).toEqual({ kind: 'sustain', silenceSec: 0.8, capSec: 60 });
    await h.key('Enter');
    expect(world.last.stoppedBy).toBe('key');
    expect(h.text()).toContain('14.2 s held');
    expect(h.text()).toContain('very steady');
    expect(h.text()).toContain('your first one');
  });

  it('microphone denied shows the recorder message', async () => {
    const world = fakeWorld();
    world.failNext = 'denied';
    renderBreath(world);
    choose(1);
    await h.click(/^Start/);
    expect(h.container.querySelector('[role="alert"]')?.textContent).toContain('System Settings');
  });
});
