// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteInfo } from '../../audio/duplex';
import { DEFAULT_PRACTICE_OPTIONS, FAKE_CLIP_ID, FAKE_NOW, FakeTrainerEngine, makeFakeClip, makeFakeTrainerController, type FakeControllerOptions, type FakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import { loadTrainerPrefs, saveTrainerPrefs } from '../trainerPrefs';
import { PracticeView, settingsSummary } from './TrainerPractice';

const release = vi.fn();
const requestWakeLock = vi.fn(async () => release);
vi.mock('../../audio/route', async (orig) => ({ ...(await orig<typeof import('../../audio/route')>()), requestWakeLock: () => requestWakeLock() }));

const screen = useScreen();
beforeEach(() => {
  release.mockClear();
  requestWakeLock.mockClear();
});

const SPEAKER: RouteInfo = { inputLabel: 'iPhone Microphone', inputs: [{ id: 'b', label: 'iPhone Microphone' }], kind: 'builtin', headphonesLikely: false, sampleRate: 48000 };

async function open(n = 5, opts: FakeControllerOptions = {}, focusHeading = false): Promise<{ ctl: FakeTrainerController; engine: FakeTrainerEngine }> {
  const ctl = makeFakeTrainerController(opts);
  screen.mount(<PracticeView clipId={FAKE_CLIP_ID} phraseNumber={n} now={FAKE_NOW} focusHeading={focusHeading} />, ctl);
  await tick();
  return { ctl, engine: ctl.engines[0] };
}
const live = () => screen.q('[role="status"][aria-live="polite"]').textContent;
const sing = async () => screen.clickAsync(screen.q('.pc-sing'));
const force = (e: FakeTrainerEngine, patch: Parameters<FakeTrainerEngine['force']>[0], position?: number) =>
  act(() => {
    if (position !== undefined) e.setPosition(position);
    e.force(patch);
  });
const pressed = () => screen.qa('[aria-pressed="true"]').map((e) => (e.textContent ?? '').trim());

describe('Practice: opening a phrase', () => {
  it('opens the engine for that phrase and shows the strip, the choices and the two big buttons', async () => {
    const { ctl, engine } = await open();
    expect(ctl.calls).toContain('openPractice');
    expect(engine.phrase.id).toBe('fake-clip-p5');
    expect(screen.q('h1').textContent).toBe('Phrase 5 of 12');
    expect(screen.q('.pr-status').textContent).toMatch(/Shawn.*Learning.*best 92/);
    expect(screen.qa('.ps-chip')).toHaveLength(8);
    expect(screen.has('.pc-grid')).toBe(true);
    expect(screen.q('.pc-listen').textContent).toMatch(/Listen/);
    expect(screen.q('.pc-sing').textContent).toMatch(/Sing/);
    expect(screen.link(/fake clip|Fake clip/).getAttribute('href')).toBe('#trainer/c/fake-clip');
  });

  it('shows a plain "getting ready" line and cannot start while the phrase loads', async () => {
    const { engine } = await open(5, { engine: { initialState: 'preparing' } });
    expect(screen.q('.pr-preparing').textContent).toBe('Getting the phrase ready…');
    expect((screen.q('.pc-sing') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.q('.pc-listen') as HTMLButtonElement).disabled).toBe(true);
    expect(live()).toBe('Getting the phrase ready.');
    force(engine, { state: 'idle' });
    expect(screen.has('.pr-preparing')).toBe(false);
    expect((screen.q('.pc-sing') as HTMLButtonElement).disabled).toBe(false);
  });

  it('has visible previous and next links, and none past the ends', async () => {
    await open(5);
    expect(screen.link(/Previous phrase, 4/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/4');
    expect(screen.link(/Next phrase, 6/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/6');
    await open(1);
    expect(screen.qa('a').some((a) => /Previous phrase/.test(a.getAttribute('aria-label') ?? ''))).toBe(false);
    await open(12);
    expect(screen.qa('a').some((a) => /Next phrase/.test(a.getAttribute('aria-label') ?? ''))).toBe(false);
  });

  it('skips hidden phrases when stepping, and opens a hidden one from a link', async () => {
    const clip = makeFakeClip();
    clip.phrases = clip.phrases.map((p, i) => (i === 5 ? { ...p, hidden: true } : p));
    await open(5, { clips: [clip] });
    expect(screen.link(/Next phrase, 7/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/7');
    await open(6, { clips: [clip] });
    expect(screen.q('h1').textContent).toBe('Phrase 6 of 11');
  });

  it('starts at the phrase\'s own speed, the count-in from Settings, and sing-along when headphones look connected', async () => {
    saveTrainerPrefs({ countInBeats: 4 });
    const clip = makeFakeClip();
    clip.phrases = clip.phrases.map((p, i) => (i === 4 ? { ...p, rate: 0.75 } : p));
    const { engine } = await open(5, { clips: [clip] });
    const o = engine.getSnapshot().options;
    expect(o).toMatchObject({ rate: 0.75, countInBeats: 4, mode: 'sing-along' });
  });

  it('uses the starting speed from Settings for a phrase with no speed of its own', async () => {
    saveTrainerPrefs({ defaultRate: 0.9 });
    const { engine } = await open(5);
    expect(engine.getSnapshot().options.rate).toBe(0.9);
  });

  it('starts in listen-then-sing when no headphones look connected, unless the singer chose otherwise in Settings', async () => {
    const a = await open(5, { engine: { route: SPEAKER } });
    expect(a.engine.getSnapshot().options.mode).toBe('turn-taking');
    expect((screen.q('input[value="turn-taking"]') as HTMLInputElement).checked).toBe(true);
    screen.unmount();
    saveTrainerPrefs({ startMode: 'sing-along' });
    const b = await open(5, { engine: { route: SPEAKER } });
    expect(b.engine.getSnapshot().options.mode).toBe('sing-along');
  });

  it('a mode the singer picked is not undone when the route is read afterwards', async () => {
    const { engine } = await open(5, { engine: { route: SPEAKER } });
    act(() => (screen.q('input[value="sing-along"]') as HTMLInputElement).click());
    expect(engine.getSnapshot().options.mode).toBe('sing-along');
    force(engine, { route: { ...SPEAKER } });
    expect(engine.getSnapshot().options.mode).toBe('sing-along');
  });

  it('keeps the screen awake while it is open and lets go when it closes', async () => {
    await open();
    expect(requestWakeLock).toHaveBeenCalledOnce();
    screen.unmount();
    await tick();
    expect(release).toHaveBeenCalledOnce();
  });

  it('closes the engine when the screen goes away', async () => {
    const { engine } = await open();
    screen.unmount();
    expect(engine.calls).toContain('dispose');
  });

  it('takes focus on its heading when it is a new screen', async () => {
    await open(5, {}, true);
    expect(document.activeElement).toBe(screen.q('h1'));
  });
});

describe('Practice: choices reach the engine', () => {
  it('speed, key, count-in and loop buttons change the engine\'s options', async () => {
    const { engine } = await open();
    act(() => screen.button('75%').click());
    expect(engine.getSnapshot().options.rate).toBe(0.75);
    expect(pressed()).toContain('75%');
    act(() => screen.button(/My key -12/).click());
    expect(engine.getSnapshot().options.guideShift).toBe(-12);
    act(() => screen.button(/4 beats/).click());
    expect(engine.getSnapshot().options.countInBeats).toBe(4);
    act(() => screen.button(/Whole phrase/).click());
    expect(engine.getSnapshot().options.loop?.from).toBe(0);
    expect(engine.getSnapshot().options.loop?.to).toBeCloseTo(6.45, 5);
  });

  it('tapping a note chip loops that note, and Clear loop puts the whole phrase back', async () => {
    const { engine } = await open();
    act(() => screen.qa<HTMLButtonElement>('.ps-chip')[3].click());
    const loop = engine.getSnapshot().options.loop;
    expect(loop?.from).toBeCloseTo(1.9 - 0.05 + 0.0, 0);
    expect(screen.text()).toMatch(/s to .* s/);
    act(() => screen.button('Clear loop').click());
    expect(engine.getSnapshot().options.loop).toBeNull();
  });

  it('shows the choices at a glance when the settings are folded away, and follows the engine\'s options', async () => {
    const { engine } = await open();
    expect(screen.q<HTMLDetailsElement>('details.pr-settings').open).toBe(true);
    expect(settingsSummary(DEFAULT_PRACTICE_OPTIONS)).toBe('Original key, 100%, sing along, 3 beats');
    expect(settingsSummary({ ...DEFAULT_PRACTICE_OPTIONS, guideShift: -12, rate: 0.75, mode: 'turn-taking', loop: { from: 1, to: 2 } })).toBe('My key -12 (octave), 75%, listen then sing, 3 beats, looping');
    force(engine, { options: { ...DEFAULT_PRACTICE_OPTIONS, rate: 0.6 } });
    expect(pressed()).toContain('60%');
  });

  it('warns when the chosen key would be out of the range the app can follow', async () => {
    const { engine } = await open();
    const ref = engine.getSnapshot().reference!;
    force(engine, { reference: { ...ref, pitch: { ...ref.pitch, medianMidi: 38 } }, options: { ...DEFAULT_PRACTICE_OPTIONS, guideShift: -12 } });
    expect(screen.text()).toMatch(/below the range the app can follow/);
  });
});

describe('Practice: listening and singing', () => {
  it('Listen plays the guide, shows Stop while it plays, and Stop stops it', async () => {
    const { engine } = await open();
    await screen.clickAsync(screen.q('.pc-listen'));
    expect(engine.calls).toContain('listen');
    force(engine, { state: 'listening' }, 1.2);
    expect(screen.q('.pc-listen').textContent).toMatch(/Stop/);
    expect(live()).toBe('Playing the phrase.');
    act(() => (screen.q('.pc-listen') as HTMLButtonElement).click());
    expect(engine.calls).toContain('stop');
  });

  it('shows the count-in, then recording with your level, and announces each change', async () => {
    const { engine } = await open();
    force(engine, { state: 'countin', countIn: 3 });
    expect(screen.q('.ps-count-n').textContent).toBe('3');
    expect(live()).toBe('Get ready. The count-in has started.');
    expect(screen.q('.pc-sing').textContent).toMatch(/Cancel/);
    force(engine, { state: 'singing', countIn: null, liveMidi: 57, level: 0.5 }, 2);
    expect(screen.has('.ps-count')).toBe(false);
    expect(live()).toBe('Recording. Sing now.');
    expect(screen.q('.pc-sing').textContent).toMatch(/Stop/);
    expect((screen.q('.pr-level-fill') as HTMLElement).style.width).toBe('50%');
    expect((screen.q('.pc-listen') as HTMLButtonElement).disabled).toBe(true);
    act(() => (screen.q('.pc-sing') as HTMLButtonElement).click());
    expect(engine.calls).toContain('stop');
    force(engine, { state: 'processing', liveMidi: null, level: 0 });
    expect(live()).toBe('Analysing your take.');
    expect(screen.q('.pc-sing').textContent).toMatch(/Analysing/);
  });

  it('a take ends in the result sheet: the score, the first fix, and the result is announced and focused', async () => {
    const { engine } = await open();
    await sing();
    expect(engine.calls).toContain('sing');
    expect(screen.q('.rs h2').textContent).toBe('How close you got');
    expect(screen.q('.dial-number').textContent).toBe('91');
    expect(live()).toBe('Score 91 out of 100. Very close. First thing to fix: Lift the flat notes.');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.q('.rs h2'));
    expect(screen.q('.pc-sing').textContent).toMatch(/Try again/);
    // The settings fold away to make room, and say what they are set to.
    expect(screen.q<HTMLDetailsElement>('details.pr-settings').open).toBe(false);
    expect(screen.q('.pr-settings-now').textContent).toBe('Original key, 100%, sing along, 3 beats');
  });

  it('Try again keeps going: a second take replaces the first result, and the third offers the next phrase', async () => {
    await open();
    await sing();
    expect(screen.q('.dial-number').textContent).toBe('91');
    expect(screen.hasButton(/Next phrase/)).toBe(false);
    await sing();
    expect(screen.q('.dial-number').textContent).toBe('99');
    expect(screen.hasButton(/Next phrase/)).toBe(false);
    await sing();
    expect(screen.q('.dial-number').textContent).toBe('99');
    await screen.clickAsync(screen.button(/Next phrase/));
    expect(window.location.hash).toBe('#trainer/c/fake-clip/p/6');
  });

  it('loads this phrase\'s history for the mastery line', async () => {
    const { ctl } = await open();
    await sing();
    expect(ctl.calls.filter((c) => c === 'listAttempts').length).toBeGreaterThan(0);
    expect(screen.text()).toMatch(/good tries at full speed/);
  });

  it('hearing it back asks the engine for the original, you, or both', async () => {
    const { engine } = await open();
    await sing();
    for (const name of [/Original/, /You/, /Both/]) await screen.clickAsync(screen.qa<HTMLButtonElement>('.rs-hear button').find((b) => name.test(b.textContent ?? ''))!);
    expect(engine.calls.filter((c) => c.startsWith('playAttempt'))).toEqual(['playAttempt:original', 'playAttempt:you', 'playAttempt:both']);
  });

  it('after a poor take it offers 75 percent, and taking the offer slows the guide', async () => {
    const { engine } = await open(5, { engine: { script: ['partial'] } });
    await sing();
    await screen.clickAsync(screen.button(/Try it at 75%/));
    expect(engine.getSnapshot().options.rate).toBe(0.75);
    expect(screen.hasButton(/Try it at 75%/)).toBe(false);
  });

  it('looping a weak region from a fix starts the loop at that speed and plays it', async () => {
    const { engine } = await open();
    await sing();
    await screen.clickAsync(screen.q('.fc-loop'));
    const o = engine.getSnapshot().options;
    expect(o.rate).toBe(0.75);
    expect(o.loop?.from).toBeCloseTo(1.2, 1);
    expect(engine.calls.filter((c) => c === 'listen').length).toBe(1);
  });

  it('an exercise on a fix opens the Practice page for it', async () => {
    await open();
    await sing();
    const exercise = screen.qa<HTMLButtonElement>('.fc button').find((b) => /Sustain|reference note|Practise all|drone/i.test(b.textContent ?? ''));
    expect(exercise).toBeTruthy();
    await screen.clickAsync(exercise!);
    expect(window.location.hash).toBe('#practice');
  });

  it('keeping recordings is a preference the singer can switch from the result', async () => {
    await open();
    await sing();
    screen.click(screen.button(/See more/));
    screen.click(screen.button(/See everything/));
    expect(loadTrainerPrefs().keepRecordings).toBe(false);
    await screen.clickAsync(screen.q('.rs-keep input[role="switch"]'));
    expect(loadTrainerPrefs().keepRecordings).toBe(true);
  });

  it('a take that could not be scored says why and is not counted as a try', async () => {
    await open(5, { engine: { script: ['no-match'] } });
    await sing();
    expect(screen.q('.rs h2').textContent).toBe('This take was not scored');
    expect(screen.has('.dial-number')).toBe(false);
    expect(live()).toMatch(/^Not scored\./);
    expect(screen.q('.pc-sing').textContent).toMatch(/Try again/);
  });
});

describe('Practice: things that go wrong', () => {
  it('an interrupted take says what happened and what to do, and Try again is there', async () => {
    const { engine } = await open(5, { engine: { failSing: { state: 'interrupted', message: 'Interrupted by another app. Nothing was scored. Tap Try again.' } } });
    await sing();
    expect(screen.q('.notice--warn').textContent).toBe('Interrupted by another app. Nothing was scored. Tap Try again.');
    // The notice carries the words; the live region only says that the take stopped.
    expect(live()).toBe('The take was stopped and not scored. The message below says what to do.');
    expect(screen.has('.rs')).toBe(false);
    const sing2 = screen.q<HTMLButtonElement>('.pc-sing');
    expect(sing2.disabled).toBe(false);
    expect(sing2.textContent).toMatch(/Sing/);
    expect(engine.getSnapshot().state).toBe('interrupted');
    expect(screen.q<HTMLButtonElement>('.pc-listen').disabled).toBe(false);
  });

  it('an engine error shows its message and keeps Listen and Sing available', async () => {
    const { engine } = await open();
    force(engine, { state: 'error', message: 'The microphone could not be started. Allow it for this site in Settings, then tap Try again.' });
    expect(screen.q('.notice--warn').textContent).toMatch(/microphone could not be started/);
    expect(live()).toBe('Something went wrong. The message below says what to do.');
    expect(screen.q<HTMLButtonElement>('.pc-sing').disabled).toBe(false);
  });

  it('a hint from the engine while idle is shown quietly', async () => {
    const { engine } = await open();
    force(engine, { message: 'No sound? Check the silent switch.' });
    expect(screen.q('.notice--info').textContent).toBe('No sound? Check the silent switch.');
  });

  it('a phrase that cannot be opened says why and can be tried again', async () => {
    const ctl = makeFakeTrainerController();
    const real = ctl.openPractice;
    let fail = true;
    ctl.openPractice = async (clipId, phraseId) => {
      if (fail) throw new Error('not implemented');
      return real(clipId, phraseId);
    };
    screen.mount(<PracticeView clipId={FAKE_CLIP_ID} phraseNumber={5} now={FAKE_NOW} focusHeading={false} />, ctl);
    await tick();
    expect(screen.q('.notice--error').textContent).toMatch(/This phrase could not be opened.*not implemented/s);
    expect(screen.link(/Back to the clip/).getAttribute('href')).toBe('#trainer/c/fake-clip');
    fail = false;
    await screen.clickAsync(screen.button(/Try again/));
    expect(screen.has('.notice--error')).toBe(false);
    expect(screen.has('.pd')).toBe(true);
  });

  it('a clip whose audio is missing sends you to add the file, without opening an engine', async () => {
    const { ctl } = await open(5, { clips: [makeFakeClip({ audioMissing: true })] });
    expect(ctl.engines).toHaveLength(0);
    expect(screen.q('.notice--warn').textContent).toMatch(/needs its audio again/);
    expect(screen.link(/Open the clip/).getAttribute('href')).toBe('#trainer/c/fake-clip');
    expect(screen.has('.pd')).toBe(false);
  });

  it('a phrase number that does not exist says so and links to the clip', async () => {
    const { ctl } = await open(99);
    expect(ctl.engines).toHaveLength(0);
    expect(screen.q('h1').textContent).toBe('There is no phrase 99 in this clip');
    expect(screen.link(/Pick a phrase/).getAttribute('href')).toBe('#trainer/c/fake-clip');
  });

  it('a clip that is not in the library says so, and a library still opening says that instead', async () => {
    const ctl = makeFakeTrainerController({ clips: [] });
    screen.mount(<PracticeView clipId="gone" phraseNumber={1} now={FAKE_NOW} focusHeading={false} />, ctl);
    expect(screen.q('h1').textContent).toBe('That clip is not in your library');
    const loading = makeFakeTrainerController({ clips: [], status: 'loading' });
    screen.mount(<PracticeView clipId="gone" phraseNumber={1} now={FAKE_NOW} focusHeading={false} />, loading);
    expect(screen.q('h1').textContent).toBe('Opening your library…');
  });

  it('warns about a Bluetooth microphone before the first take', async () => {
    await open(5, {
      engine: {
        route: { inputLabel: 'AirPods Pro', inputs: [{ id: 'a', label: 'AirPods Pro' }, { id: 'b', label: 'iPhone Microphone' }], kind: 'bluetooth', headphonesLikely: true, sampleRate: 16000, inputSampleRate: 16000 },
      },
    });
    expect(screen.text()).toMatch(/Bluetooth microphone/);
    await screen.clickAsync(screen.button('Choose the microphone'));
    expect(window.location.hash).toBe('#settings');
  });

  it('singing along without headphones asks first and does not start the take', async () => {
    const { engine } = await open(5, { engine: { route: SPEAKER } });
    act(() => (screen.q('input[value="sing-along"]') as HTMLInputElement).click());
    await sing();
    expect(screen.q('.pc-ask').textContent).toMatch(/No headphones detected/);
    expect(engine.calls).not.toContain('sing');
    await screen.clickAsync(screen.button('Listen first, then sing'));
    expect(engine.calls).toContain('sing');
    expect(engine.getSnapshot().options.mode).toBe('turn-taking');
  });
});
