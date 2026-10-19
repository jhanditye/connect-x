// @vitest-environment jsdom
// The pitch test's "next step" (UX-4): after the summary, one clear thing to do next, chosen from the same numbers the
// summary shows. Each rule is checked on the pure chooser with the REAL summariser (src/skills/score), then the screen
// is driven end to end for the links, buttons, keyboard and the workout (embedded) case.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarisePitchTest } from '../../../skills/score';
import { registerThirdOf } from '../../../skills/theory';
import type { HeldNoteScore, RegisterThird, Strictness } from '../../../skills/types';
import { singLine, SR } from '../../../skills/score/fixtures';
import { DEFAULT_SING_DEPS } from './deps';
import { noteList, pitchTestNextStep, PitchTestScreen, type PitchNextStep } from './PitchTestScreen';
import { rangeFor } from './common';
import { baseProps, fakeWorld, harness, heldScore, type Harness } from './testKit';

const TOL: Record<Strictness, number> = { gentle: 50, standard: 25, strict: 15 };

/** A scored note: target midi, held cents, register (and octave offset). */
function n(targetMidi: number, heldCents: number, register: RegisterThird, octaveOffset = 0): HeldNoteScore {
  return heldScore({ targetMidi, heldCents, register, octaveOffset, within: Math.abs(heldCents) <= 25, findings: [] });
}
function quiet(targetMidi: number): HeldNoteScore {
  return heldScore({ targetMidi, status: 'too-quiet', heldCents: null, landingCents: null, stabilityCents: null, timeToLandSec: null, within: false, findings: [] });
}

/** Ten notes over a baritone range, 3 low / 4 middle / 3 high, with the held cents given in that order. */
const MIDIS = [46, 48, 50, 53, 55, 56, 58, 61, 63, 65];
const REGS: RegisterThird[] = ['low', 'low', 'low', 'mid', 'mid', 'mid', 'mid', 'high', 'high', 'high'];
function ten(cents: number[], octave: number[] = []): HeldNoteScore[] {
  return cents.map((c, i) => n(MIDIS[i], c, REGS[i], octave[i] ?? 0));
}

function choose(notes: HeldNoteScore[], strictness: Strictness = 'standard'): PitchNextStep | null {
  const tol = TOL[strictness];
  return pitchTestNextStep(summarisePitchTest(notes, tol), notes, tol, strictness);
}
const labels = (s: PitchNextStep | null) => s?.actions.map((a) => a.label) ?? [];
const views = (s: PitchNextStep | null) => s?.actions.flatMap((a) => (a.kind === 'open' ? [a.view] : [])) ?? [];

describe('pitchTestNextStep: one rule per result', () => {
  it('high notes that sit flat -> Match the note on the high notes, naming the notes outside the band', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 0, 4, -35, -30, -28]));
    expect(s?.id).toBe('register');
    expect(s?.title).toBe('Practise: Match the note on your high notes');
    expect(s?.text).toContain('Your high notes sat about 31 cents flat on average (C♯4, D♯4 and F4 were outside ±25 cents)');
    expect(s?.text).toContain('aim for the top edge');
    expect(s?.lowConfidence).toBe(false);
    expect(views(s)).toEqual(['match']);
    expect(labels(s)).toEqual(['Practise: Match the note', 'Take the test again']);
  });

  it('a register judged on only two notes is marked as a first hint (low confidence)', () => {
    // 9 notes: the high third has only two of them.
    const notes = ten([3, -4, 2, 5, -3, 0, 4, -35, -32]).slice(0, 9);
    const s = choose(notes);
    expect(s?.id).toBe('register');
    expect(s?.text).toContain('only 2 notes, so take it as a first hint');
    expect(s?.lowConfidence).toBe(true);
  });

  it('low notes that sit sharp -> the same step for the low notes, with the sharp tip', () => {
    const s = choose(ten([30, 34, 26, 2, -3, 1, 4, 0, -2, 3]));
    expect(s?.id).toBe('register');
    expect(s?.title).toContain('your low notes');
    expect(s?.text).toContain('30 cents sharp');
    expect(s?.text).toContain('aim for the bottom edge');
  });

  it('a flat lean overall (no one register 20 cents off) -> a tip and Match the note, aiming higher', () => {
    const s = choose(ten([-15, -28, -12, -16, -30, -10, -14, -12, -27, -16]));
    expect(s?.id).toBe('bias');
    expect(s?.title).toBe('Practise: Match the note, aiming a little higher');
    expect(s?.text).toContain('Overall you tend to sit about 18 cents flat');
    expect(s?.text).toContain('top edge');
    expect(views(s)).toEqual(['match']);
  });

  it('a sharp lean overall -> aiming lower, with the "ease off the push" tip', () => {
    const s = choose(ten([15, 28, 12, 16, 30, 10, 14, 12, 27, 16]));
    expect(s?.id).toBe('bias');
    expect(s?.title).toBe('Practise: Match the note, aiming a little lower');
    expect(s?.text).toContain('18 cents sharp');
    expect(s?.text).toContain('bottom edge');
  });

  it('a whole voice about 23 cents flat is an overall lean, not a "low notes" problem (the register must stand out)', () => {
    const s = choose(ten([-30, -26, -18, -20, -28, -21, -17, -21, -27, -20]));
    expect(s?.id).toBe('bias');
    expect(s?.text).toContain('Overall you tend to sit about 23 cents flat');
    expect(s?.text).not.toContain('low notes');
  });

  it('a register clearly worse than an overall lean is still named', () => {
    const s = choose(ten([-18, -16, -20, -15, -19, -17, -18, -40, -42, -38]));
    expect(s?.id).toBe('register');
    expect(s?.text).toContain('Your high notes sat about 40 cents flat');
  });

  it('inside the band with an even lean everywhere: the lean is described as overall', () => {
    const s = choose(ten([-20, -22, -21, -19, -20, -23, -21, -22, -20, -21]));
    expect(s?.id).toBe('all-in');
    expect(s?.text).toContain('Overall you lean about 21 cents flat, still inside the band.');
  });

  it('two or more different notes come first -> a slower retest and Sing intervals', () => {
    // Even with high notes off as well: finding the note comes before fine tuning.
    const s = choose(ten([110, 3, -2, 4, -200, 1, -3, -35, -30, -28]));
    expect(s?.id).toBe('wrong-notes');
    expect(s?.text).toMatch(/^2 notes came out as different notes \(A♯2 and G3\)\./);
    expect(labels(s)).toEqual(['Take the test again, slowly', 'Sing intervals']);
    expect(views(s)).toEqual(['sing-intervals']);
  });

  it('one different note with everything else in the band -> the same step, saying the rest was fine', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 150, 4, -6, 2, 3]));
    expect(s?.id).toBe('wrong-notes');
    expect(s?.text).toContain('One note came out as a different note (G♯3), and every other measured note landed within ±25 cents.');
  });

  it('one different note does not hide a register that sits off', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 150, 4, -35, -30, -28]));
    expect(s?.id).toBe('register');
  });

  it('two or more octave slips (otherwise in tune) -> a slower retest and Sing intervals; they still count as right', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 0, 4, -6, 2, 3], [0, -1, 0, 0, 0, 1, 0, 0, 0, 0]));
    expect(s?.id).toBe('octave');
    expect(s?.text).toContain('2 notes came out an octave away');
    expect(s?.text).toContain('They still count as right.');
    expect(views(s)).toEqual(['sing-intervals']);
    // A single octave slip is not a habit: everything in the band -> raise the bar.
    expect(choose(ten([3, -4, 2, 5, -3, 0, 4, -6, 2, 3], [0, -1]))?.id).toBe('all-in');
  });

  it('everything inside the band on Standard -> Try Strict or Sequences', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 0, 4, -6, 2, 3]));
    expect(s?.id).toBe('all-in');
    expect(s?.title).toBe('Next: try Strict');
    expect(s?.text).toContain('Every measured note landed within ±25 cents. Well done.');
    expect(s?.text).toContain('Strict (±15 cents)');
    expect(s?.actions[0]).toEqual({ kind: 'strictness', strictness: 'strict', label: 'Try Strict' });
    expect(views(s)).toEqual(['sequence']);
  });

  it('everything inside the band on Gentle -> Try Standard (one step at a time)', () => {
    const s = choose(ten([30, -40, 2, 5, -3, 0, 4, -6, 2, 3]), 'gentle');
    expect(s?.id).toBe('all-in');
    expect(s?.actions[0]).toEqual({ kind: 'strictness', strictness: 'standard', label: 'Try Standard' });
  });

  it('everything inside the band on Strict -> Sequences and Sing intervals', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 0, 4, -6, 2, 3]), 'strict');
    expect(s?.id).toBe('all-in');
    expect(s?.text).toContain('the strictest band');
    expect(s?.actions.some((a) => a.kind === 'strictness')).toBe(false);
    expect(views(s)).toEqual(['sequence', 'sing-intervals']);
  });

  it('inside the band but leaning: says so without calling it a problem', () => {
    const s = choose(ten([3, -4, 2, 5, -3, 0, 4, -22, -21, -23]));
    expect(s?.id).toBe('all-in');
    expect(s?.text).toContain('Your high notes lean about 22 cents flat, still inside the band.');
  });

  it('a few misses on both sides with no pattern -> Match the note, naming them', () => {
    const s = choose(ten([3, -32, 2, 5, -3, 31, 4, -6, 2, 3]));
    expect(s?.id).toBe('spread');
    expect(s?.text).toContain('2 of 10 measured notes landed outside ±25 cents (C3 and G♯3), some sharp and some flat');
    expect(views(s)).toEqual(['match']);
  });

  it('too few measured notes -> says it cannot tell yet (low confidence) and names no habit, even when they were off', () => {
    const notes = [n(46, -40, 'low'), n(55, -38, 'mid'), quiet(58), n(61, -42, 'high'), quiet(63), n(65, -39, 'high')];
    const s = choose(notes);
    expect(s?.id).toBe('unsure');
    expect(s?.lowConfidence).toBe(true);
    expect(s?.text).toContain('Only 4 notes could be measured, which is too few to say what to practise.');
    expect(s?.text).toContain('2 more notes were too quiet or unsteady to score.');
    expect(s?.text).not.toMatch(/flat|sharp/);
    expect(labels(s)).toEqual(['Take the test again']);
  });

  it('only different notes -> the different-note step, never "0 notes measured"', () => {
    const s = choose([n(46, 150, 'low')]);
    expect(s?.id).toBe('wrong-notes');
    expect(s?.text).not.toContain('0 notes');
  });

  it('nothing scored -> no next step (the summary already says to check the microphone)', () => {
    expect(choose([quiet(46), quiet(50)])).toBeNull();
  });

  it('noteList: lowest first, each once, and a count past four', () => {
    expect(noteList([{ targetMidi: 64 }, { targetMidi: 60 }, { targetMidi: 64 }])).toBe('C4 and E4');
    expect(noteList([60, 62, 64, 65, 67, 69].map((targetMidi) => ({ targetMidi })))).toBe('C4, D4, E4, F4 and 2 more');
    expect(noteList([])).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// The screen

let h: Harness;
let hashBefore = '';
beforeEach(() => {
  hashBefore = window.location.hash;
});
afterEach(() => {
  h?.unmount();
  window.location.hash = hashBefore;
});

const RANGE = rangeFor('baritone', null);

/** A world whose scorer holds each target at `centsFor(target, register)`, summarised by the real summariser. */
function worldWith(centsFor: (midi: number, register: RegisterThird, take: number) => number) {
  const world = fakeWorld();
  let take = 0;
  world.deps.scoreHeldNote = vi.fn((_s: Float32Array, _r: number, targetMidi: number) => {
    const register = registerThirdOf(targetMidi, RANGE);
    const c = centsFor(targetMidi, register, take++);
    return heldScore({ targetMidi, register, heldCents: c, within: Math.abs(c) <= 25, findings: [] });
  });
  world.deps.summarisePitchTest = DEFAULT_SING_DEPS.summarisePitchTest;
  return world;
}

async function runTest(world: ReturnType<typeof fakeWorld>, count = 10, over: Record<string, unknown> = {}) {
  h = harness();
  const props = { ...baseProps(), ...over };
  act(() => h.root.render(<PitchTestScreen {...props} plan={{ count }} deps={world.deps} />));
  await h.click(/Start the test/);
  for (let i = 0; i < count; i++) {
    await act(async () => world.last.autoStop('auto-held'));
    await h.flush();
    await h.click(i < count - 1 ? /Next note/ : /See my results/);
    if (i < count - 1) await h.click(/Play and sing/);
  }
  expect(h.text()).toContain('Your results');
  return props;
}

const section = () => h.container.querySelector('.sing-next') as HTMLElement | null;
const link = (name: RegExp) => Array.from(h.container.querySelectorAll('.sing-next a')).find((a) => name.test(a.textContent ?? '')) as HTMLAnchorElement | undefined;

describe('PitchTestScreen: next step on the summary', () => {
  it('high notes flat: shows the step after the findings with a Match the note link that opens it', async () => {
    await runTest(worldWith((_m, r) => (r === 'high' ? -35 : 3)));
    const next = section();
    expect(next?.dataset.next).toBe('register');
    expect(next?.getAttribute('aria-labelledby')).toBe('pitch-next-title');
    expect(h.container.querySelector('#pitch-next-title')?.textContent).toBe('Practise: Match the note on your high notes');
    expect(next?.textContent).toContain('Your high notes sat about 35 cents flat on average');
    // The step sits between the findings and the tables.
    const findings = h.container.querySelector('.sing-findings') as Element;
    const table = h.container.querySelector('.sing-table') as Element;
    expect(findings.compareDocumentPosition(next as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((next as Node).compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A real link (Tab reaches it, Return follows it) to the Skills route.
    const a = link(/Practise: Match the note/);
    expect(a?.getAttribute('href')).toBe('#skills/match');
    expect(a?.className).toContain('button--accent');
    await act(async () => a?.click());
    expect(window.location.hash).toBe('#skills/match');
    // One accent button: the plain retest steps back.
    expect(h.button(/Take the test again \(Return\)/).className).not.toContain('button--accent');
  });

  it('Return on the focused link is left to the link (the screen does not restart under it)', async () => {
    await runTest(worldWith((_m, r) => (r === 'high' ? -35 : 3)));
    const a = link(/Practise: Match the note/) as HTMLAnchorElement;
    a.focus();
    expect(document.activeElement).toBe(a);
    await h.key('Enter', a);
    expect(h.text()).toContain('Your results');
    // Return elsewhere still restarts, as before.
    await h.key('Enter');
    expect(h.text()).toContain('Start the test');
  });

  it('all in the band: "Try Strict" saves the stricter band and starts a new test', async () => {
    const props = await runTest(worldWith(() => 4));
    expect(section()?.dataset.next).toBe('all-in');
    expect(link(/Sequences/)?.getAttribute('href')).toBe('#skills/sequence');
    await h.click(/^Try Strict\s*$/);
    expect(props.onPrefs).toHaveBeenCalledWith({ strictness: 'strict' });
    expect(h.text()).toContain('Start the test');
    expect(section()).toBeNull();
  });

  it('different notes: "Take the test again, slowly" restarts, and Sing intervals is a link', async () => {
    // The 2nd and 5th notes come out as a different note (a semitone and more away).
    const world = worldWith((_m, _r, take) => (take === 1 ? 120 : take === 4 ? -150 : 2));
    await runTest(world);
    expect(section()?.dataset.next).toBe('wrong-notes');
    expect(link(/Sing intervals/)?.getAttribute('href')).toBe('#skills/sing-intervals');
    await h.click(/Take the test again, slowly/);
    expect(h.text()).toContain('Start the test');
  });

  it('too few notes: marked as not enough to be sure, with only a retest', async () => {
    await runTest(worldWith(() => -40), 3);
    const next = section();
    expect(next?.dataset.next).toBe('unsure');
    expect(next?.className).toContain('sing-next--unsure');
    expect(next?.textContent).toContain('Next step (not enough to be sure)');
    expect(next?.querySelectorAll('a')).toHaveLength(0);
    expect(next?.textContent).not.toMatch(/sit about|flat/);
  });

  it('inside the workout (embedded): keeps the advice, never navigates away', async () => {
    await runTest(worldWith((_m, r) => (r === 'high' ? -35 : 3)), 10, { embedded: true });
    const next = section();
    expect(next?.dataset.next).toBe('register');
    expect(next?.textContent).toContain('Your high notes sat about 35 cents flat');
    expect(next?.querySelectorAll('a')).toHaveLength(0);
    expect(h.maybeButton(/^Take the test again\s*$/)?.className).toContain('button--accent');
  });

  it('without a way to save preferences, "Try Strict" is not offered', async () => {
    await runTest(worldWith(() => 4), 10, { onPrefs: undefined });
    expect(section()?.dataset.next).toBe('all-in');
    expect(h.maybeButton(/Try Strict/)).toBeNull();
    expect(link(/Sequences/)).toBeDefined();
  });

  it('real scorer on a synthetic voice: high notes sung 35 cents flat -> the high-notes step, naming exactly those notes', async () => {
    const world = fakeWorld();
    const { scoreHeldNote, summarisePitchTest } = DEFAULT_SING_DEPS;
    Object.assign(world.deps, { scoreHeldNote, summarisePitchTest });
    h = harness();
    act(() => h.root.render(<PitchTestScreen {...baseProps()} plan={{ count: 10 }} deps={world.deps} />));
    await h.click(/Start the test/);
    const high: number[] = [];
    for (let i = 0; i < 10; i++) {
      const target = world.plays[world.plays.length - 1][0].midis[0];
      const isHigh = registerThirdOf(target, RANGE) === 'high';
      if (isHigh) high.push(target);
      world.last.samples = singLine([{ midi: target + (isHigh ? -0.35 : 0), durSec: 2 }]);
      world.last.sampleRate = SR;
      await act(async () => world.last.autoStop('auto-held'));
      await h.flush();
      await h.click(i < 9 ? /Next note/ : /See my results/);
      if (i < 9) await h.click(/Play and sing/);
    }
    expect(high.length).toBeGreaterThanOrEqual(2);
    const next = section();
    expect(next?.dataset.next).toBe('register');
    const cents = Number(next?.textContent?.match(/high notes sat about (\d+) cents flat/)?.[1]);
    expect(cents).toBeGreaterThanOrEqual(30);
    expect(cents).toBeLessThanOrEqual(40);
    expect(next?.textContent).toContain(`(${noteList(high.map((targetMidi) => ({ targetMidi })))} were outside ±25 cents)`);
  }, 60000);

  it('nothing scored: no next step, just the microphone advice', async () => {
    const world = fakeWorld();
    world.deps.scoreHeldNote = vi.fn((_s: Float32Array, _r: number, targetMidi: number) => heldScore({ targetMidi, status: 'too-quiet', heldCents: null, landingCents: null, stabilityCents: null, findings: [] }));
    world.deps.summarisePitchTest = DEFAULT_SING_DEPS.summarisePitchTest;
    h = harness();
    act(() => h.root.render(<PitchTestScreen {...baseProps()} plan={{ count: 1 }} deps={world.deps} />));
    await h.click(/Start the test/);
    await act(async () => world.last.autoStop('cap'));
    await h.flush();
    await h.click(/Skip this note/);
    expect(h.text()).toContain('No note could be scored');
    expect(section()).toBeNull();
  });
});
