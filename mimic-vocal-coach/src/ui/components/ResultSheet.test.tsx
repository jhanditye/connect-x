// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attemptFromComparison,
  FAKE_CLIP_ID,
  FAKE_NOW,
  FAKE_PHRASE_NOTES,
  makeFakeClip,
  makeFakePhraseAnalysis,
  makeFakePhraseComparison,
  makeFakePracticeResult,
  type ComparisonScenario,
} from '../../testing/trainerFixtures';
import type { PracticeResult } from '../../trainer/engine';
import type { AttemptRecord, VoiceAnalysis } from '../../types';
import { isScored, leadWords, ResultSheet, resultAnnouncement, shownScore, wrongNoteCount, type ResultSheetProps } from './ResultSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const clip = makeFakeClip();
const phrase = clip.phrases[4];
const reference = makeFakePhraseAnalysis();
const result = (s: ComparisonScenario): PracticeResult => makeFakePracticeResult(s, clip, phrase);

function sheet(over: Partial<ResultSheetProps> & { scenario?: ComparisonScenario } = {}) {
  const { scenario = 'flat', ...rest } = over;
  const f = { onHear: vi.fn(), onOpenExercises: vi.fn(), onLoop: vi.fn() };
  const props: ResultSheetProps = { result: result(scenario), reference, phrase, clipKind: 'solo', rate: 1, triesThisVisit: 1, history: [], keepRecordings: false, ...f, ...rest };
  act(() => root.render(<ResultSheet {...props} />));
  return f;
}
const text = () => container.textContent ?? '';
const btn = (name: RegExp): HTMLButtonElement => {
  const b = Array.from(container.querySelectorAll('button')).find((el) => name.test(`${el.textContent} ${el.getAttribute('aria-label') ?? ''}`));
  if (!b) throw new Error(`No button ${name}`);
  return b;
};
const hasBtn = (name: RegExp) => Array.from(container.querySelectorAll('button')).some((el) => name.test(`${el.textContent} ${el.getAttribute('aria-label') ?? ''}`));
const click = (el: Element) => act(() => (el as HTMLElement).click());

function attempts(scenario: ComparisonScenario, n: number, rate = 1): AttemptRecord[] {
  return Array.from({ length: n }, (_, i) => attemptFromComparison(makeFakePhraseComparison(scenario, { shift: -12 }), { id: `h${scenario}${i}`, clipId: FAKE_CLIP_ID, phraseId: phrase.id, at: FAKE_NOW - i * 60_000, rate }));
}

describe('ResultSheet: a scored take', () => {
  it('opens with the number, the words, the key, the four skills, the hear buttons and the first fix', () => {
    sheet();
    expect(container.querySelector('h2')?.textContent).toBe('How close you got');
    expect(container.querySelector('.dial-number')?.textContent).toBe('91');
    expect(text()).toMatch(/Very close\./);
    expect(text()).toMatch(/Two notes sat about 40 cents under the original/);
    expect(text()).toContain('Original C4, your key C3 (an octave lower)');
    expect(text()).toMatch(/Sync offset 160 ms: your headphones plus your reaction\. Not counted against you\./);
    const skills = Array.from(container.querySelectorAll('.rs-skill')).map((s) => s.textContent?.replace(/\s+/g, ' ').trim());
    expect(skills).toEqual(['Pitch84 out of 100', 'Timing100 out of 100', 'Tone90 out of 100', 'Expression88 out of 100']);
    expect(Array.from(container.querySelectorAll('.rs-hear button')).map((b) => b.textContent?.trim())).toEqual(['Original', 'You', 'Both']);
    expect(container.querySelectorAll('.fc')).toHaveLength(1);
    expect(text()).toContain('Lift the flat notes');
    expect(text()).not.toContain('Add the vibrato');
    expect(container.querySelector('.nt')).toBeNull();
  });

  it('See more shows every fix and the note chips; See everything adds the table, the plot and the tone words', () => {
    sheet();
    click(btn(/See more/));
    expect(container.querySelectorAll('.fc')).toHaveLength(2);
    expect(text()).toContain('Add the vibrato');
    expect(container.querySelectorAll('.rs-notechip')).toHaveLength(8);
    expect(container.querySelector('.nt')).toBeNull();
    click(btn(/See everything/));
    expect(container.querySelector('.nt')).not.toBeNull();
    expect(container.querySelector('svg.pov, .pov svg, [class*="pov"]')).not.toBeNull();
    expect(text()).toMatch(/Tone, in words/);
    expect(text()).toMatch(/This phrase so far/);
    expect(hasBtn(/See everything/)).toBe(false);
    click(btn(/Show less/));
    expect(container.querySelector('.nt')).toBeNull();
    expect(container.querySelectorAll('.rs-notechip')).toHaveLength(8);
    click(btn(/Hide the detail/));
    expect(container.querySelectorAll('.rs-notechip')).toHaveLength(0);
  });

  it('the more button says whether the detail is open', () => {
    sheet();
    expect(btn(/See more/).getAttribute('aria-expanded')).toBe('false');
    click(btn(/See more/));
    expect(btn(/See everything/).getAttribute('aria-expanded')).toBe('true');
  });

  it('gives each note chip words (never colour alone) and loops the note at 75 percent', () => {
    const f = sheet({ defaultDetent: 2 });
    const flagged = Array.from(container.querySelectorAll('.rs-notechip--flag'));
    expect(flagged).toHaveLength(2);
    expect(flagged[0].textContent).toContain('flat');
    expect(flagged[0].getAttribute('aria-label')).toMatch(/flat 38 cents.*Loops this note at 75 percent/);
    click(flagged[0]);
    const loop = f.onLoop.mock.calls[0][0];
    expect(loop.rate).toBe(0.75);
    expect(loop.from).toBeCloseTo(FAKE_PHRASE_NOTES[2].start - 0.1, 5);
  });

  it('the hear buttons ask for the original, you, or both', () => {
    const f = sheet();
    click(btn(/Original/));
    click(btn(/You/));
    click(btn(/Both/));
    expect(f.onHear.mock.calls.map((c) => c[0])).toEqual(['original', 'you', 'both']);
  });

  it('a fix with a weak region offers to loop it, and exercise links go to the Practice page', () => {
    const f = sheet({ defaultDetent: 2 });
    const exercise = Array.from(container.querySelectorAll('button')).find((b) => /Practise all|drone|Sustain/i.test(b.textContent ?? ''));
    expect(exercise).toBeTruthy();
    click(exercise as Element);
    expect(f.onOpenExercises).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]));
    const loops = Array.from(container.querySelectorAll('.fc-loop'));
    expect(loops.map((b) => b.textContent?.trim())).toEqual(['Loop 1.2–3.4 s at 75%']);
    click(loops[0]);
    expect(f.onLoop).toHaveBeenCalledWith(expect.objectContaining({ rate: 0.75 }));
  });

  it('Try again is a primary button only when the screen asks for it', () => {
    sheet();
    expect(hasBtn(/Try again/)).toBe(false);
    const onTryAgain = vi.fn();
    sheet({ onTryAgain });
    click(btn(/Try again/));
    expect(onTryAgain).toHaveBeenCalledOnce();
  });

  it('suggests 75 percent after a poor take at full speed, and full speed after a good one at 75', () => {
    const onSlower = vi.fn();
    sheet({ scenario: 'partial', onSlower });
    click(btn(/Try it at 75%/));
    expect(onSlower).toHaveBeenCalledOnce();
    expect(hasBtn(/Back to full speed/)).toBe(false);
    const onFaster = vi.fn();
    sheet({ scenario: 'perfect', rate: 0.75, onFaster });
    click(btn(/Back to full speed/));
    expect(onFaster).toHaveBeenCalledOnce();
    expect(hasBtn(/Try it at 75%/)).toBe(false);
  });

  it('offers the next phrase as soon as the take is as good as the mastery mark, after three tries otherwise, or once it is mastered', () => {
    const onNext = vi.fn();
    sheet({ onNext, triesThisVisit: 1 }); // a 91: no need to wait for the third try
    click(btn(/Next phrase/));
    expect(onNext).toHaveBeenCalledOnce();
    sheet({ onNext, triesThisVisit: 2, scenario: 'partial' }); // a weaker take on the second try: keep practising
    expect(hasBtn(/Next phrase/)).toBe(false);
    sheet({ onNext, triesThisVisit: 3, scenario: 'partial' });
    expect(hasBtn(/Next phrase/)).toBe(true);
    sheet({ onNext, triesThisVisit: 1, scenario: 'partial', phrase: clip.phrases[3] });
    expect(hasBtn(/Next phrase/)).toBe(true);
    sheet({ triesThisVisit: 5 }); // no next phrase to go to
    expect(hasBtn(/Next phrase/)).toBe(false);
  });

  it('counts good tries toward mastery, and says when it is mastered', () => {
    sheet({ history: [] });
    expect(text()).toContain('Counts toward mastery when sung at full speed: 3 good tries are needed.');
    expect(text()).not.toContain('Mastered after');
    sheet({ history: attempts('perfect', 2) });
    expect(text()).toContain('2 of 3 good tries at full speed so far');
    sheet({ history: attempts('perfect', 2), phrase: clip.phrases[3] });
    expect(text()).toContain('Mastered. It will come back for review.');
  });

  it('shows no mastery count until the history includes this take, and never as a live region', () => {
    sheet({ history: [], historyReady: false });
    expect(container.querySelector('.rs-mastery')).toBeNull();
    sheet({ history: attempts('perfect', 1), historyReady: true });
    const line = container.querySelector('.rs-mastery');
    expect(line?.textContent).toContain('1 of 3 good tries');
    expect(line?.getAttribute('role')).toBeNull();
  });

  it('rounds a short phrase to the nearest 5 and says so', () => {
    const short: VoiceAnalysis = { ...reference, notes: reference.notes.slice(0, 3) };
    sheet({ reference: short });
    expect(container.querySelector('.dial-number')?.textContent).toBe('90');
    expect(text()).toMatch(/rounded to the nearest 5/);
    sheet({ reference });
    expect(container.querySelector('.dial-number')?.textContent).toBe('91');
    expect(text()).not.toMatch(/rounded to the nearest 5/);
  });

  it('says tone is not compared for a full song, and which skills could not be measured', () => {
    const r = result('flat');
    r.comparison.score.skills.tone = null;
    r.comparison.score.skills.timing = null;
    sheet({ result: r, clipKind: 'mix' });
    expect(text()).toContain('Not compared for a full song');
    expect(text()).toContain('Needs two or more clear notes');
    expect(container.querySelectorAll('.rs-skill--none')).toHaveLength(2);
  });

  it('shows a caution beside the number, with the reason', () => {
    sheet({ scenario: 'partial', defaultDetent: 1 });
    expect(text()).toContain('Treat this score with care');
    expect(text()).toMatch(/Only 52% of the original phrase was matched/);
  });

  it('never calls a take with a wrong note "very close", even when the number is high', () => {
    sheet({ scenario: 'wrong-note' });
    expect(container.querySelector('.dial-number')?.textContent).toBe('95');
    expect(container.querySelector('.rs-sentence strong')?.textContent).toBe('Close, with one wrong note.');
    expect(text()).toMatch(/On D4 you sang E4/);
    expect(resultAnnouncement(result('wrong-note'), reference)).toMatch(/^Score 95 out of 100\. Close, with one wrong note\./);
    expect(wrongNoteCount(result('wrong-note'))).toBe(1);
    expect(wrongNoteCount(result('flat'))).toBe(0);
  });

  it('words a score by its band, and by the wrong notes only when the band would be the top one', () => {
    expect(leadWords('excellent', 0)).toBe('Very close.');
    expect(leadWords('excellent', 2)).toBe('Close, with 2 wrong notes.');
    expect(leadWords('good', 1)).toBe('Close.');
    expect(leadWords('fair', 0)).toBe('Getting there.');
    expect(leadWords('needs-work', 3)).toBe('Not there yet.');
  });

  it('a perfect take says nothing stood out and offers no fix', () => {
    sheet({ scenario: 'perfect' });
    expect(text()).toMatch(/Very close\./);
    expect(text()).toMatch(/Nothing stood out to fix/);
    expect(container.querySelectorAll('.fc')).toHaveLength(0);
  });

  it('keeps recordings only when asked, from the last level', () => {
    const onKeepRecordings = vi.fn();
    sheet({ onKeepRecordings, defaultDetent: 3 });
    const toggle = container.querySelector('input[role="switch"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    click(toggle);
    expect(onKeepRecordings).toHaveBeenCalledWith(true);
    sheet({ defaultDetent: 3 });
    expect(container.querySelector('input[role="switch"]')).toBeNull();
  });

  it('the heading can take focus, so the screen can move it there', () => {
    const ref = createRef<HTMLHeadingElement>();
    sheet({ headingRef: ref });
    expect(ref.current?.tagName).toBe('H2');
    expect(ref.current?.tabIndex).toBe(-1);
    act(() => ref.current?.focus());
    expect(document.activeElement).toBe(ref.current);
  });
});

describe('ResultSheet: a take that cannot be scored', () => {
  it('shows no number and no skills, says why, and the next step is still there', () => {
    sheet({ scenario: 'no-match', onTryAgain: () => undefined });
    expect(container.querySelector('h2')?.textContent).toBe('This take was not scored');
    expect(container.querySelector('.dial-number')).toBeNull();
    expect(container.querySelector('.rs-skills')).toBeNull();
    expect(text()).toMatch(/does not line up with the original phrase|does not line up with the reference phrase|too different/);
    expect(hasBtn(/Try again/)).toBe(true);
    expect(hasBtn(/See more/)).toBe(false);
  });

  it('speaker bleed: the notice says not saved, "You" and "Both" are off, and there is no score', () => {
    const r = result('perfect');
    r.comparison.score.trust = { level: 'invalid', reasons: ['Sounds like the playback.'] };
    r.saved = false;
    r.notice = 'This sounds like the playback, not you. Use headphones and try again.';
    sheet({ result: r });
    expect(container.querySelector('.dial-number')).toBeNull();
    expect(text()).toContain('This sounds like the playback, not you.');
    expect(btn(/You/).disabled).toBe(true);
    expect(btn(/Both/).disabled).toBe(true);
    expect(btn(/Original/).disabled).toBe(false);
  });

  it('a not-scored take\'s words are on screen once as plain text, not as a second live region next to the page\'s announcement', () => {
    const r = result('perfect');
    r.comparison.score.trust = { level: 'invalid', reasons: ['Sounds like the playback.'] };
    r.notice = 'This sounds like the playback, not you. Use headphones and try again.';
    sheet({ result: r });
    const quiet = Array.from(container.querySelectorAll('.notice')).find((n) => /sounds like the playback, not you/.test(n.textContent ?? ''));
    expect(quiet).toBeTruthy();
    expect(quiet?.getAttribute('role')).toBeNull();
    sheet({ scenario: 'no-match' });
    expect(Array.from(container.querySelectorAll('.notice')).every((n) => n.getAttribute('role') === null)).toBe(true);
  });

  it('too little singing is not a score of zero', () => {
    const r = result('flat');
    r.comparison.score.status = 'low-evidence';
    r.comparison.score.overall = null;
    r.comparison.score.notes = ['I could hardly hear you. Move closer to the microphone, then try again.'];
    sheet({ result: r });
    expect(isScored(r)).toBe(false);
    expect(container.querySelector('.dial-number')).toBeNull();
    expect(text()).toContain('I could hardly hear you');
  });
});

describe('ResultSheet helpers', () => {
  it('shownScore rounds, clamps, and rounds short phrases to 5', () => {
    expect(shownScore(91.4, false)).toBe(91);
    expect(shownScore(91.4, true)).toBe(90);
    expect(shownScore(98, true)).toBe(100);
    expect(shownScore(103, false)).toBe(100);
    expect(shownScore(-4, false)).toBe(0);
  });

  it('announces the score and the first fix for a screen reader, or why there is none', () => {
    expect(resultAnnouncement(result('flat'), reference)).toBe('Score 91 out of 100. Very close. First thing to fix: Lift the flat notes.');
    expect(resultAnnouncement(result('perfect'), reference)).toMatch(/Nothing stood out to fix/);
    expect(resultAnnouncement(result('no-match'), reference)).toMatch(/^Not scored\./);
  });
});
