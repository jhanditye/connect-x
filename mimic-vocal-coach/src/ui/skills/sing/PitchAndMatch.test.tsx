// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchNoteScreen } from './MatchNoteScreen';
import { PitchTestScreen } from './PitchTestScreen';
import { baseProps, fakeWorld, harness, heldScore, type Harness } from './testKit';

let h: Harness;
afterEach(() => h?.unmount());

function renderPitch(world = fakeWorld(), count = 3, propsOver: Partial<ReturnType<typeof baseProps>> = {}) {
  h = harness();
  const props = { ...baseProps(), ...propsOver };
  act(() => h.root.render(<PitchTestScreen {...props} plan={{ count }} deps={world.deps} />));
  return { world, props };
}

describe('PitchTestScreen', () => {
  it('plays the note first, then opens the microphone, shows the voice but no target while singing, and scores the take', async () => {
    const order: string[] = [];
    const world = fakeWorld();
    const play = world.deps.playEvents;
    const start = world.deps.startCapture;
    world.deps.playEvents = (e, o) => {
      order.push('play');
      return play(e, o);
    };
    world.deps.startCapture = (o) => {
      order.push('mic');
      return start(o);
    };
    renderPitch(world);
    expect(h.text()).toContain('How accurate is my pitch?');
    expect(h.text()).toContain('±25 cents');
    await h.click(/Start the test/);
    expect(order).toEqual(['play', 'mic']);
    expect(world.plays[0]).toHaveLength(1);
    const target = world.plays[0][0].midis[0];
    // Baritone comfortable range A2-F4.
    expect(target).toBeGreaterThanOrEqual(45);
    expect(target).toBeLessThanOrEqual(65);
    expect(h.text()).toContain('Sing now');
    await act(async () => {
      world.last.emit(target - 0.4);
      world.last.emit(target - 0.4);
    });
    // A test of the ear: the voice is traced, but no needle and no target band while singing.
    expect(h.text()).toContain('Sing by ear');
    expect(h.text()).not.toContain('40 cents flat');
    expect(h.container.querySelector('.sing-trace-pitch')).not.toBeNull();
    expect(h.container.querySelectorAll('.sing-trace-band')).toHaveLength(0);
    await act(async () => {
      world.last.emit(target + 0.05);
    });
    expect(h.text()).not.toMatch(/In the band/);
    await act(async () => world.last.autoStop('auto-held'));
    await h.flush();
    expect(world.deps.scoreHeldNote).toHaveBeenCalledWith(expect.any(Float32Array), 16000, target, expect.objectContaining({ a4Hz: 440, toleranceCents: 25 }));
    expect(h.text()).toContain('Note 1: −12 cents');
    expect(h.text()).toContain('Nicely in tune.');
    // Announced, and focus moved to the result heading.
    expect(h.container.querySelector('[aria-live="polite"]')?.textContent).toContain('Held 12 cents flat, inside the band');
    expect(document.activeElement?.textContent).toContain('Note 1');
  });

  it('runs the whole test and reports one session with every note and the summary', async () => {
    const { world, props } = renderPitch(fakeWorld(), 3);
    await h.click(/Start the test/);
    for (let i = 0; i < 3; i++) {
      await act(async () => world.last.autoStop('auto-held'));
      await h.flush();
      await h.click(i < 2 ? /Next note/ : /See my results/);
      if (i < 2) await h.click(/Play and sing/);
    }
    expect(h.text()).toContain('Your results');
    expect(h.text()).toContain('By part of your range');
    expect(h.text()).toContain('You tend to sit 12 cents flat.');
    expect(props.onDone).toHaveBeenCalledTimes(1);
    const session = props.onDone.mock.calls[0][0];
    expect(session.kind).toBe('pitch-test');
    expect(session.notes).toHaveLength(3);
    expect(session.summary).not.toHaveProperty('findings');
    expect(session.summary.scored).toBe(3);
    expect(session.strictness).toBe('standard');
    expect(session.voiceType).toBe('baritone');
  });

  it('shows the microphone error with the recorder wording and lets the singer try again', async () => {
    const world = fakeWorld();
    world.failNext = 'denied';
    renderPitch(world);
    await h.click(/Start the test/);
    const alert = h.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('The microphone did not start');
    expect(alert?.textContent).toContain('System Settings');
    await h.click(/^Try again/);
    expect(world.captures).toHaveLength(1);
  });

  it('does not score an interrupted take and says why in Mac words', async () => {
    const { world, props } = renderPitch();
    await h.click(/Start the test/);
    await act(async () => world.last.interrupt('hidden'));
    await h.flush();
    expect(h.text()).toContain('Take interrupted');
    expect(h.text()).toContain('This tab was in the background');
    expect(world.deps.scoreHeldNote).not.toHaveBeenCalled();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('says "too quiet to score" instead of a number, and keeps it out of the averages', async () => {
    const world = fakeWorld();
    world.deps.scoreHeldNote = vi.fn((_s, _r, targetMidi: number) => heldScore({ targetMidi, status: 'too-quiet', heldCents: null, landingCents: null, stabilityCents: null, findings: [] }));
    const { props } = renderPitch(world, 1);
    await h.click(/Start the test/);
    await act(async () => world.last.autoStop('cap'));
    await h.flush();
    expect(h.text()).toContain('Too quiet to score');
    expect(h.text()).not.toContain('Note 1: −');
    expect(h.maybeButton(/Next note/)).toBeNull();
    await h.click(/Skip this note/);
    expect(h.text()).toContain('No note could be scored');
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('keeps the microphone closed when the prompt could not play', async () => {
    const world = fakeWorld();
    world.stallNext = true;
    renderPitch(world);
    await h.click(/Start the test/);
    expect(world.captures).toHaveLength(0);
    expect(h.text()).toContain('Nothing played');
    expect(h.text()).toContain('menu bar');
  });

  it('keyboard: Return starts and moves on, Space stops while singing and replays otherwise', async () => {
    const { world } = renderPitch(fakeWorld(), 2);
    await h.key('Enter');
    expect(world.captures).toHaveLength(1);
    await h.key(' ');
    expect(world.captures[0].stoppedBy).toBe('key');
    expect(h.text()).toContain('Note 1: −12 cents');
    const plays = world.plays.length;
    await h.key(' ');
    expect(world.plays.length).toBe(plays + 1);
    expect(world.captures).toHaveLength(1);
    await h.key('Enter');
    expect(h.text()).toContain('Note 2 of 2');
    await h.key('Enter');
    expect(world.captures).toHaveLength(2);
    await h.key('Enter');
    expect(world.captures[1].stoppedBy).toBe('key');
  });

  it('reports a partly finished test when the singer leaves', async () => {
    const { world, props } = renderPitch(fakeWorld(), 5);
    await h.click(/Start the test/);
    await act(async () => world.last.autoStop('auto-held'));
    await h.flush();
    await h.click(/Skills/);
    expect(props.onExit).toHaveBeenCalled();
    expect(props.onDone).toHaveBeenCalledTimes(1);
    expect(props.onDone.mock.calls[0][0].notes).toHaveLength(1);
  });
});

describe('MatchNoteScreen', () => {
  function renderMatch(world = fakeWorld(), prefs = {}) {
    h = harness();
    const props = baseProps(prefs);
    act(() => h.root.render(<MatchNoteScreen {...props} plan={{ count: 2 }} deps={world.deps} />));
    return { world, props };
  }

  it('locks in after holding inside the band and stops the take by itself', async () => {
    const { world, props } = renderMatch();
    await h.click(/Play and sing/);
    const target = world.plays[0][0].midis[0];
    expect(world.last.opts.rule).toEqual({ kind: 'notes', expectedNotes: 1, silenceSec: 1.5, capSec: 20 });
    await act(async () => {
      world.last.emit(target - 1);
      world.last.emit(target - 0.5);
    });
    expect(h.text()).toContain('50 cents flat');
    await act(async () => {
      for (let i = 0; i < 12; i++) world.last.emit(target + 0.1);
    });
    await h.flush();
    expect(world.captures[0].stoppedBy).toBe('auto-held');
    expect(h.text()).toMatch(/Locked in after 0\.\d s/);
    await h.click(/Next note/);
    await h.click(/Play and sing/);
    await act(async () => world.last.autoStop('cap'));
    await h.flush();
    expect(h.text()).toContain('Not locked in this time');
    await h.click(/Finish/);
    expect(h.text()).toContain('1 of 2 notes locked in');
    expect(props.onDone).toHaveBeenCalledTimes(1);
    const s = props.onDone.mock.calls[0][0];
    expect(s.kind).toBe('match');
    expect(s.attempts.map((a: { locked: boolean }) => a.locked)).toEqual([true, false]);
    expect(s.drone).toBe(false);
  });

  it('offers the drone only after the headphones question', async () => {
    const { world, props } = renderMatch();
    const box = h.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    const yes = Array.from(h.container.querySelectorAll('input[type="radio"]'))[0] as HTMLInputElement;
    await act(async () => yes.click());
    expect(props.onPrefs).toHaveBeenCalledWith({ headphones: true });
    h.unmount();
    const r = renderMatch(fakeWorld(), { headphones: true });
    const box2 = h.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box2.disabled).toBe(false);
    await act(async () => box2.click());
    await h.click(/Play and sing/);
    expect(r.world.drones).toHaveLength(1);
    await act(async () => r.world.last.autoStop('button'));
    await h.flush();
    expect(r.world.dronesStopped).toBe(1);
    void world;
  });
});
