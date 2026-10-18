// @vitest-environment jsdom
// The screens wired to the REAL scorers (src/skills/score) on synthetic singing with a known answer: only playback
// and the microphone are faked. Checks that what the screen shows is what the scorer measured.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { singLine, SR } from '../../../skills/score/fixtures';
import { DEFAULT_SING_DEPS } from './deps';
import { PitchTestScreen } from './PitchTestScreen';
import { SequenceScreen } from './SequenceScreen';
import { baseProps, fakeWorld, harness, type Harness } from './testKit';

let h: Harness;
afterEach(() => h?.unmount());

function realScoringWorld() {
  const w = fakeWorld();
  const { scoreHeldNote, summarisePitchTest, createLockTracker, scoreSequence, scoreSungInterval, scoreHiss, scoreLongTone } = DEFAULT_SING_DEPS;
  Object.assign(w.deps, { scoreHeldNote, summarisePitchTest, createLockTracker, scoreSequence, scoreSungInterval, scoreHiss, scoreLongTone });
  return w;
}

describe('singing screens with the real scorers', () => {
  it('"7 6 5 4 3 2" sung an octave low with a flat 7: the 7 is marked, the rest are in the band, the octave is fine', async () => {
    const world = realScoringWorld();
    h = harness();
    const props = baseProps();
    act(() => h.root.render(<SequenceScreen {...props} deps={world.deps} />));
    await h.click(/Play the key and sing/);
    const tonic = world.plays[0].find((e) => e.role === 'tonic')?.midis[0] as number;
    const steps = [11, 9, 7, 5, 4, 2];
    world.last.samples = singLine(steps.map((s, i) => ({ midi: tonic + s - 12 + (i === 0 ? -0.4 : 0), durSec: 0.6 })));
    world.last.sampleRate = SR;
    await act(async () => world.last.autoStop('auto-silence'));
    await h.flush();
    const items = Array.from(h.container.querySelectorAll('.sing-degree'));
    expect(items).toHaveLength(6);
    expect(items[0].className).not.toContain('sing-acc--within');
    expect(items[0].getAttribute('aria-label')).toMatch(/^7: (3\d|4\d) cents flat/);
    for (const el of items.slice(1)) expect(el.className).toContain('sing-acc--within');
    // The octave is said once (the scorer's finding; the screen's own line is not repeated under it).
    expect(h.text()).toContain('You sang the line an octave lower. That is fine');
    expect(h.text()).not.toContain('an octave lower than it played');
    expect(h.text()).toContain('5 of 6 notes in the band');
    await h.click(/^Finish/);
    const s = props.onDone.mock.calls[0][0];
    expect(s.items[0].octaveOffset).toBe(-1);
    expect(s.items[0].perNote[0].degree).toBe(7);
    expect(s.items[0].perNote[0].cents).toBeLessThan(-30);
    expect(s.items[0].perNote[0].cents).toBeGreaterThan(-50);
  }, 30000);

  it('pitch test: a note sung 30 cents sharp reads about +30', async () => {
    const world = realScoringWorld();
    h = harness();
    act(() => h.root.render(<PitchTestScreen {...baseProps()} plan={{ count: 1 }} deps={world.deps} />));
    await h.click(/Start the test/);
    const target = world.plays[0][0].midis[0];
    world.last.samples = singLine([{ midi: target + 0.3, durSec: 2 }]);
    world.last.sampleRate = SR;
    await act(async () => world.last.autoStop('auto-held'));
    await h.flush();
    const title = h.container.querySelector('.sing-result-title')?.textContent ?? '';
    const cents = Number(title.match(/\+(\d+) cents/)?.[1]);
    expect(cents).toBeGreaterThanOrEqual(25);
    expect(cents).toBeLessThanOrEqual(35);
  }, 30000);
});
