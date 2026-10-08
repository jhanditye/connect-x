// @vitest-environment jsdom
// "Isolate the vocal first" in the Add clips sheet and in the review, with a FAKE separator (no onnxruntime, no model, no worker).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeparationAvailability } from '../../audio/separation/client';
import { SeparationError } from '../../audio/separation/errors';
import { TrainerContext } from '../../state/trainerContext';
import { makeFakeTrainerController, type FakeTrainerController } from '../../testing/trainerFixtures';
import type { ImportProgress, PreparedClip } from '../../trainer/import';
import { ISOLATED_TONE_NOTE, ISOLATED_VOCAL_WARNING } from '../../trainer/importCopy';
import { fakePrepared } from '../../trainer/importTestKit';
import { ImportSheet, overallProgress, type ImportSheetProps } from './ImportSheet';
import { resetSplitMarkerForTests } from '../../trainer/splitMarker';
import { DEFAULT_ISOLATE_CHOICE, etaWords, parseClock, requestFromChoice } from './IsolateOptions';
import type { SamplePlayer } from './samplePlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('.imp-host').forEach((el) => el.remove());
});

const idlePlayer = (): SamplePlayer => ({ play: async () => true, stop: () => undefined, position: () => null, playing: false, dispose: () => undefined });

const MANIFEST = { name: 'Fake separator', version: '9', bytes: 20 * 1024 * 1024, sha256: 'a'.repeat(64), licence: 'MIT', source: 'test', inputRate: 44100 };
const available = (over: Partial<SeparationAvailability> = {}): SeparationAvailability => ({ available: true, reason: null, manifest: MANIFEST, modelKept: false, ...over });
const unavailable = (): SeparationAvailability => ({ available: false, reason: 'no-manifest', manifest: null, modelKept: false });

async function mount(ctl: FakeTrainerController, props: Partial<ImportSheetProps> = {}) {
  const onClose = vi.fn();
  await act(async () => {
    root.render(
      <TrainerContext.Provider value={ctl}>
        <ImportSheet onClose={onClose} createPlayer={idlePlayer} {...props} />
      </TrainerContext.Provider>,
    );
  });
  return { onClose };
}

const sheet = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('.imp-sheet');
  if (!el) throw new Error('The sheet is not open');
  return el;
};
const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = sheet().querySelector<T>(sel);
  if (!el) throw new Error(`Nothing matches ${sel}`);
  return el;
};
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(sheet().querySelectorAll<T>(sel));
const matches = (el: Element, re: RegExp): boolean => re.test((el.textContent ?? '').trim()) || re.test(el.getAttribute('aria-label') ?? '');
const button = (text: RegExp): HTMLButtonElement => {
  const b = $$<HTMLButtonElement>('button').find((el) => matches(el, text));
  if (!b) throw new Error(`No button matching ${text}`);
  return b;
};
const hasButton = (text: RegExp): boolean => $$<HTMLButtonElement>('button').some((el) => matches(el, text));
const clickAsync = (el: Element) => act(async () => (el as HTMLElement).click());
const text = () => sheet().textContent ?? '';
const optionCheckbox = () => $$<HTMLInputElement>('.imp-isolate input[type="checkbox"]')[0];

async function choose(...files: File[]) {
  const input = $<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function typeInto(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function selectValue(el: HTMLSelectElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const audioFile = (name: string) => new File(['x'], name, { type: 'audio/wav' });

function controller(prepare: (file: File, onProgress?: (p: ImportProgress) => void, signal?: AbortSignal) => Promise<PreparedClip>) {
  const ctl = makeFakeTrainerController({ clips: [] });
  ctl.prepareClip = vi.fn(prepare) as unknown as FakeTrainerController['prepareClip'];
  return ctl;
}
const isolatedOf = (p: PreparedClip): PreparedClip => ({ ...p, kind: 'solo', suggestedKind: 'solo', warnings: [ISOLATED_VOCAL_WARNING], isolation: { model: 'Fake separator', version: '9', sourceStartSec: 0 } });

describe('the option on the Add clips screen', () => {
  it('is not shown when the app cannot do it here, and the screen is exactly what it was', async () => {
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => unavailable() } });
    expect(text()).not.toMatch(/isolate the vocal/i);
    expect(document.querySelector('.imp-isolate')).toBeNull();
  });

  it('is not shown, and nothing is asked, in a plain browser test environment with no worker (the default check)', async () => {
    await mount(makeFakeTrainerController({ clips: [] }));
    expect(document.querySelector('.imp-isolate')).toBeNull();
  });

  it('is shown off by default, with the cost and the limits stated before anything happens', async () => {
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => available() } });
    const box = optionCheckbox();
    expect(box.checked).toBe(false);
    expect(text()).toMatch(/Isolate the vocal first \(AI\)/);
    expect(text()).toMatch(/Takes minutes/);
    // The details (size, battery, limits) open with the switch; the one line above is all that shows while it is off.
    expect(document.querySelector('.imp-isolate-more')).toBeNull();
  });

  it('turning it on says what it costs: the download size from the manifest, minutes of work, battery, and that the result is approximate', async () => {
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    const more = $('.imp-isolate').textContent ?? '';
    expect(more).toMatch(/about 20 MB/);
    expect(more).toMatch(/about 31 MB/); // the model and the 11 MB engine that runs it
    expect(more).toMatch(/engine/);
    expect(more).toMatch(/minutes/);
    expect(more).toMatch(/battery/i);
    expect(more).toMatch(/approximate/i);
    expect(more).toMatch(/nothing is uploaded/i);
    expect(more).toMatch(/Only up to \d+ minutes/);
  });

  it('says once that the last split was cut off, when an earlier page left its note behind', async () => {
    localStorage.setItem('mimic.isolateInProgress.v1', JSON.stringify({ fileName: 'Long song.mp3', seconds: 300, startedAt: 1, session: 'an-earlier-page' }));
    resetSplitMarkerForTests();
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => available() } });
    const note = $('.imp-isolate [role="status"]').textContent ?? '';
    expect(note).toMatch(/Long song\.mp3/);
    expect(note).toMatch(/did not finish/);
    expect(note).toMatch(/shorter part/);
    expect(localStorage.getItem('mimic.isolateInProgress.v1')).toBeNull();
    resetSplitMarkerForTests();
  });

  it('starts with one minute of the song, not the most: the longest run is a choice, not the default', async () => {
    expect(DEFAULT_ISOLATE_CHOICE.minutes).toBe(1);
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    const select = $('.imp-isolate select') as HTMLSelectElement;
    expect(select.value).toBe('1');
    expect(requestFromChoice({ ...DEFAULT_ISOLATE_CHOICE, on: true })).toEqual({ startSec: 0, maxSec: 60 });
  });

  it('says there is no download when the model is already on the phone', async () => {
    await mount(makeFakeTrainerController({ clips: [] }), { separation: { check: async () => available({ modelKept: true }) } });
    await clickAsync(optionCheckbox());
    expect($('.imp-isolate').textContent).toMatch(/no download/i);
  });

  it('files chosen with it off are read exactly as before (no fourth argument)', async () => {
    const ctl = controller(async (f) => ({ ...fakePrepared({ name: f.name }) }));
    await mount(ctl, { separation: { check: async () => available() } });
    await choose(audioFile('a.wav'));
    const call = (ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call.length).toBe(3);
  });

  it('files chosen with it on are read from the start with the default minute', async () => {
    const ctl = controller(async (f) => isolatedOf(fakePrepared({ name: f.name })));
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('song.wav'));
    const call = (ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toEqual({ isolate: { startSec: 0, maxSec: 60 } });
  });

  it('choosing the most takes the whole cap', async () => {
    const ctl = controller(async (f) => isolatedOf(fakePrepared({ name: f.name })));
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await selectValue($<HTMLSelectElement>('.imp-isolate select'), '5');
    await choose(audioFile('song.wav'));
    expect((ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls[0][3]).toEqual({ isolate: { startSec: 0, maxSec: 300 } });
  });

  it('takes the start and the length the person chose', async () => {
    const ctl = controller(async (f) => isolatedOf(fakePrepared({ name: f.name })));
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await typeInto($<HTMLInputElement>('.imp-isolate input[type="text"]'), '1:30');
    await selectValue($<HTMLSelectElement>('.imp-isolate select'), '2');
    await choose(audioFile('song.wav'));
    expect((ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls[0][3]).toEqual({ isolate: { startSec: 90, maxSec: 120 } });
  });

  it('a start that is not a time is explained and no file can be chosen until it is fixed', async () => {
    const ctl = controller(async (f) => fakePrepared({ name: f.name }));
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await typeInto($<HTMLInputElement>('.imp-isolate input[type="text"]'), 'soon');
    expect($('.imp-isolate .field-error').textContent).toMatch(/minutes and seconds/);
    expect($<HTMLInputElement>('input[type="file"]').disabled).toBe(true);
    await typeInto($<HTMLInputElement>('.imp-isolate input[type="text"]'), '0:45');
    expect($<HTMLInputElement>('input[type="file"]').disabled).toBe(false);
  });

  it('the choice helpers: clock parsing, the request, and the time-left words', () => {
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('90')).toBe(90);
    expect(parseClock('')).toBe(0);
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('x')).toBeNull();
    expect(requestFromChoice({ on: false, start: '0:00', minutes: 5 })).toBeNull();
    expect(requestFromChoice({ on: true, start: 'x', minutes: 5 })).toBeNull();
    expect(requestFromChoice({ on: true, start: '0:10', minutes: 99 })).toEqual({ startSec: 10, maxSec: 300 });
    expect(etaWords(null)).toMatch(/Working out/);
    expect(etaWords(20)).toMatch(/Under a minute/);
    expect(etaWords(190)).toBe('About 3 min left');
  });
});

describe('while a song is being split', () => {
  it('shows the download, then the splitting with the time left, and gives the isolate steps most of the bar', async () => {
    let report: ((p: ImportProgress) => void) | undefined;
    let release!: () => void;
    const ctl = controller(async (f, onProgress) => {
      report = onProgress;
      await new Promise<void>((r) => (release = r));
      return isolatedOf(fakePrepared({ name: f.name }));
    });
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('song.wav'));
    expect(text()).toMatch(/Cancel and leave this file out/);
    expect(text()).toMatch(/takes minutes/i);

    await act(async () => report?.({ fileIndex: 0, fileCount: 1, name: 'song.wav', phase: 'downloading-model', fraction: 0.5, isolating: true }));
    expect(text()).toMatch(/Downloading the vocal model \(one time\)/);
    expect(text()).toMatch(/kept on this phone/);

    await act(async () => report?.({ fileIndex: 0, fileCount: 1, name: 'song.wav', phase: 'isolating', fraction: 0.5, isolating: true, etaSec: 190 }));
    expect(text()).toMatch(/Splitting the song into voice and band/);
    expect(text()).toMatch(/About 3 min left/);
    const bar = $('[role="progressbar"]');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(50); // 0.14 + 0.71 * 0.5, rounded

    await act(async () => {
      release();
    });
    expect(text()).toMatch(/Check this clip/);
    expect(text()).toMatch(/Isolated vocal \(AI\)/);
    expect(text()).toContain(ISOLATED_TONE_NOTE);
    // A vocal is not "a full song": the switch is gone, so it cannot be read as a band by mistake.
    expect(text()).not.toMatch(/This is a full song/);
  });

  it('the plain plan is unchanged for a file that is not isolated, and the isolate plan reaches 100 percent', () => {
    expect(overallProgress({ fileIndex: 0, fileCount: 1, name: 'a', phase: 'analysing', fraction: 0.5 })).toBeCloseTo(0.61, 2);
    expect(overallProgress({ fileIndex: 0, fileCount: 1, name: 'a', phase: 'analysing', fraction: 0.5, isolating: true })).toBeCloseTo(0.91, 2);
    expect(overallProgress({ fileIndex: 0, fileCount: 1, name: 'a', phase: 'segmenting', fraction: 1, isolating: true })).toBe(1);
  });

  it('Cancel stops the split (the signal is aborted) and nothing is added', async () => {
    let signal: AbortSignal | undefined;
    const ctl = controller(async (_f, _p, s) => {
      signal = s;
      return new Promise<PreparedClip>(() => undefined); // the worker is terminated: it never answers
    });
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('song.wav'));
    await clickAsync(button(/Cancel and leave this file out/));
    expect(signal?.aborted).toBe(true);
    expect(text()).toMatch(/Nothing was added/);
    expect(ctl.calls).not.toContain('commitClip');
  });

  it.each([
    ['the model is missing from this site', new SeparationError('model-missing', 'This copy of Mimic does not include the vocal-isolation model, so a song cannot be split here.')],
    ['the download fails', new SeparationError('download-failed', 'The vocal model could not be downloaded. Check your connection and try again.', true)],
    ['the download does not match the manifest', new SeparationError('hash-mismatch', 'The downloaded vocal model does not match what this site published, so it was thrown away and not used.', true)],
  ])('when %s the reason is shown, with Try again and a way to add the song without isolating', async (_what, error) => {
    const ctl = controller(async (f, _p, _s) => {
      if ((ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls.length === 1) throw error;
      return fakePrepared({ name: f.name });
    });
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('song.wav'));
    expect(text()).toContain(error.message);
    expect(hasButton(/Try again/)).toBe(true);
    await clickAsync(button(/Add it without isolating/));
    const calls = (ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1].length).toBe(3); // read the ordinary way
    expect(text()).toMatch(/Check this clip/);
    expect(text()).not.toMatch(/Isolated vocal \(AI\)/);
  });

  it('does not split the next song in the background while the first is being reviewed (it runs the phone hard), but does when it is not isolating', async () => {
    const ctl = controller(async (f) => isolatedOf(fakePrepared({ name: f.name })));
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('one.wav'), audioFile('two.wav'));
    expect((ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as File).name)).toEqual(['one.wav']);

    const plain = controller(async (f) => fakePrepared({ name: f.name }));
    act(() => root.unmount());
    root = createRoot(container);
    document.querySelectorAll('.imp-host').forEach((el) => el.remove());
    await mount(plain, { separation: { check: async () => available() } });
    await choose(audioFile('one.wav'), audioFile('two.wav'));
    expect((plain.prepareClip as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as File).name)).toEqual(['one.wav', 'two.wav']);
  });

  it('Try again reads the same file with the same isolate choice', async () => {
    const ctl = controller(async (f) => {
      if ((ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls.length === 1) throw new SeparationError('download-failed', 'The vocal model could not be downloaded.', true);
      return isolatedOf(fakePrepared({ name: f.name }));
    });
    await mount(ctl, { separation: { check: async () => available() } });
    await clickAsync(optionCheckbox());
    await choose(audioFile('song.wav'));
    await clickAsync(button(/Try again/));
    const calls = (ctl.prepareClip as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][3]).toEqual({ isolate: { startSec: 0, maxSec: 60 } });
    expect(text()).toMatch(/Isolated vocal \(AI\)/);
  });
});

describe('the review of a song that was found to be a full mix', () => {
  const mixPrepared = () => fakePrepared({ name: 'Band take.wav', kind: 'mix' });

  it('offers to pull the vocal out, with the cost, and nothing is split until the person taps', async () => {
    const run = vi.fn();
    const ctl = controller(async () => mixPrepared());
    await mount(ctl, { separation: { check: async () => available(), isolate: run } });
    await choose(audioFile('Band take.wav'));
    expect(text()).toMatch(/Pull the vocal out of the song\?/);
    expect(text()).toMatch(/about 20 MB/);
    expect(text()).toMatch(/battery/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('is not offered when isolation is unavailable', async () => {
    const ctl = controller(async () => mixPrepared());
    await mount(ctl, { separation: { check: async () => unavailable() } });
    await choose(audioFile('Band take.wav'));
    expect(text()).toMatch(/Check this clip/);
    expect(text()).not.toMatch(/Pull the vocal out/);
  });

  it('splits on a tap, shows progress and the time left, then reads the vocal as a solo with the trust note', async () => {
    let finish!: (p: PreparedClip) => void;
    const run = vi.fn(async (_p: PreparedClip, onProgress: (p: ImportProgress) => void) => {
      onProgress({ fileIndex: 0, fileCount: 1, name: 'Band take.wav', phase: 'isolating', fraction: 0.5, isolating: true, etaSec: 100 });
      return new Promise<PreparedClip>((r) => (finish = r));
    });
    const ctl = controller(async () => mixPrepared());
    await mount(ctl, { separation: { check: async () => available(), isolate: run } });
    await choose(audioFile('Band take.wav'));
    await clickAsync(button(/Isolate the vocal \(AI\)/));
    expect(run).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Splitting the song into voice and band/);
    expect(text()).toMatch(/About 2 min left/);
    expect(hasButton(/^Cancel$/)).toBe(true);

    await act(async () => finish(isolatedOf(mixPrepared())));
    expect(text()).toMatch(/Isolated vocal \(AI\)/);
    expect(text()).toContain(ISOLATED_TONE_NOTE);
    expect(text()).toMatch(/Fake separator \(9\)/);
    expect(text()).not.toMatch(/This is a full song/);
    expect(text()).not.toMatch(/Pull the vocal out of the song\?/);
  });

  it('Cancel aborts the split and leaves the full-song review as it was', async () => {
    let signal: AbortSignal | undefined;
    const run = vi.fn(
      (_p: PreparedClip, _on: (p: ImportProgress) => void, s: AbortSignal) =>
        new Promise<PreparedClip>((_resolve, reject) => {
          signal = s;
          s.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        }),
    );
    const ctl = controller(async () => mixPrepared());
    await mount(ctl, { separation: { check: async () => available(), isolate: run } });
    await choose(audioFile('Band take.wav'));
    await clickAsync(button(/Isolate the vocal \(AI\)/));
    await clickAsync(button(/^Cancel$/));
    expect(signal?.aborted).toBe(true);
    expect(text()).toMatch(/Pull the vocal out of the song\?/);
    expect(text()).toMatch(/This is a full song/);
    expect(document.querySelector('.rev-busy')).toBeNull();
    expect($$('[role="alert"], .notice--error').length).toBe(0);
  });

  it('a failed split shows the reason and leaves the review as it was, ready to try again', async () => {
    const run = vi.fn(async () => {
      throw new SeparationError('run-failed', 'Splitting the song failed (out of memory). Close other apps and try a shorter part.', true);
    });
    const ctl = controller(async () => mixPrepared());
    await mount(ctl, { separation: { check: async () => available(), isolate: run } });
    await choose(audioFile('Band take.wav'));
    await clickAsync(button(/Isolate the vocal \(AI\)/));
    expect(text()).toMatch(/out of memory/);
    expect(text()).toMatch(/This is a full song/);
    expect(hasButton(/Isolate the vocal \(AI\)/)).toBe(true);
  });

  it('saving the isolated clip hands the committed clip the isolation mark', async () => {
    const run = vi.fn(async (p: PreparedClip) => isolatedOf(p));
    const ctl = controller(async () => mixPrepared());
    const commit = vi.spyOn(ctl, 'commitClip');
    await mount(ctl, { separation: { check: async () => available(), isolate: run } });
    await choose(audioFile('Band take.wav'));
    await clickAsync(button(/Isolate the vocal \(AI\)/));
    const owned = $<HTMLInputElement>('.rev-footer .rev-owned input[type="checkbox"]');
    await act(async () => owned.click());
    await clickAsync(button(/Save clip/));
    expect(commit).toHaveBeenCalledTimes(1);
    const [prepared, edits] = commit.mock.calls[0];
    expect(prepared.isolation).toEqual({ model: 'Fake separator', version: '9', sourceStartSec: 0 });
    expect(edits.kind).toBe('solo');
  });

  it('a clip read as a solo gets the same offer folded away, for any file', async () => {
    const ctl = controller(async () => fakePrepared({ name: 'Voice.wav' }));
    await mount(ctl, { separation: { check: async () => available(), isolate: vi.fn() } });
    await choose(audioFile('Voice.wav'));
    const folded = $$('details.rev-isolate-offer');
    expect(folded).toHaveLength(1);
    expect(folded[0].textContent).toMatch(/Is this a song\? Pull the vocal out/);
    expect(text()).not.toMatch(/Pull the vocal out of the song\?/);
  });
});
