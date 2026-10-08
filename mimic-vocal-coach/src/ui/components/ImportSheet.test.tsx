// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainerContext } from '../../state/trainerContext';
import { QuotaError, StoreUnavailableError } from '../../storage/clips';
import { makeFakeClip, makeFakeTrainerController, type FakeTrainerController } from '../../testing/trainerFixtures';
import type { ImportProgress, PreparedClip } from '../../trainer/import';
import { fakePrepared } from '../../trainer/importTestKit';
import { ImportSheet, overallProgress, saveErrorMessage, type ImportSheetProps } from './ImportSheet';
import type { SamplePlayer } from './samplePlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let outside: HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  outside = document.createElement('button');
  outside.textContent = 'Page behind';
  document.body.appendChild(outside);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  outside.remove();
  document.querySelectorAll('.imp-host').forEach((el) => el.remove());
});

const idlePlayer = (): SamplePlayer => ({ play: async () => true, stop: () => undefined, position: () => null, playing: false, dispose: () => undefined });

function mount(ctl: FakeTrainerController, props: Partial<ImportSheetProps> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  act(() => {
    root.render(
      <TrainerContext.Provider value={ctl}>
        <ImportSheet onClose={onClose} onSaved={onSaved} createPlayer={idlePlayer} {...props} />
      </TrainerContext.Provider>,
    );
  });
  return { onClose, onSaved };
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
const click = (el: Element) => act(() => (el as HTMLElement).click());
const clickAsync = (el: Element) => act(async () => (el as HTMLElement).click());
const text = () => sheet().textContent ?? '';

async function choose(...files: File[]) {
  const input = $<HTMLInputElement>('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const audioFile = (name: string) => new File(['x'], name, { type: 'audio/wav' });

/** Lets the sheet read files with a prepared clip per name, optionally held back until released. */
function controllerReading(prepared: Record<string, PreparedClip | Error>, opts: { hold?: boolean } = {}) {
  const ctl = makeFakeTrainerController({ clips: [] });
  const releases: Record<string, () => void> = {};
  const order: string[] = [];
  ctl.prepareClip = vi.fn(async (file: File, onProgress?: (p: ImportProgress) => void) => {
    order.push(file.name);
    onProgress?.({ fileIndex: 0, fileCount: 1, name: file.name, phase: 'analysing', fraction: 0.5 });
    if (opts.hold) await new Promise<void>((r) => (releases[file.name] = r));
    const out = prepared[file.name];
    if (!out) throw new Error(`No fake for ${file.name}`);
    if (out instanceof Error) throw out;
    return out;
  });
  return { ctl, releases, order };
}

async function tickAndSave() {
  const owned = $$<HTMLInputElement>('.rev-section input[type="checkbox"]').pop()!;
  if (!owned.checked) click(owned);
  await clickAsync(button(/Save clip/));
}

describe('ImportSheet: choosing files', () => {
  it('opens as a modal dialog with the steps, the formats and the help a person with no file yet needs', () => {
    mount(makeFakeTrainerController({ clips: [] }));
    const dialog = sheet();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Add clips');
    expect(text()).toMatch(/Add clips from music you own/);
    expect(text()).toMatch(/Get a file into Files/);
    expect(text()).toMatch(/Voice Memo: open it, tap Share, then Save to Files/);
    expect(text()).toMatch(/Everything stays on this device/);
    expect(text()).toMatch(/\.mov, \.mp4, \.m4v/);
    const input = $<HTMLInputElement>('input[type="file"]');
    expect(input.multiple).toBe(true);
    for (const token of ['video/*', '.mov', '.m4v', '.m4a', 'audio/mp4', '.qta']) expect(input.accept.split(',')).toContain(token);
    // The help sections.
    const summaries = $$('details summary').map((s) => s.textContent);
    expect(summaries).toEqual(['Videos from your phone', 'Protected songs and Apple Music', 'No isolated vocal?']);
    expect($$('details')[0].textContent).toMatch(/Encode Media.*Audio Only/);
    expect($$('details')[0].textContent).toMatch(/150 MB or 15 minutes/);
    expect($$('details')[1].textContent).toMatch(/DRM-free copy of a song you own/);
    expect(document.documentElement.classList.contains('imp-open')).toBe(true);
  });

  it('keeps focus inside, hides the page behind it, and gives both back when it closes', () => {
    outside.focus();
    mount(makeFakeTrainerController({ clips: [] }));
    expect(sheet().contains(document.activeElement)).toBe(true);
    expect(outside.closest('[inert]')).toBe(outside);
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.getAttribute('aria-hidden')).toBe('true');
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const nodes = $$<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled), summary').filter((el) => !el.closest('details:not([open])') || el.tagName === 'SUMMARY');
    nodes[nodes.length - 1].focus();
    act(() => {
      nodes[nodes.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(nodes[0]);
    act(() => {
      nodes[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(nodes[nodes.length - 1]);

    act(() => root.unmount());
    expect(document.querySelector('.imp-sheet')).toBeNull();
    expect(container.hasAttribute('inert')).toBe(false);
    expect(container.hasAttribute('aria-hidden')).toBe(false);
    expect(document.documentElement.classList.contains('imp-open')).toBe(false);
    expect(document.activeElement).toBe(outside);
    root = createRoot(container);
  });

  it('closes with the Close button and with Escape', () => {
    const { onClose } = mount(makeFakeTrainerController({ clips: [] }));
    click(button(/^Close$/));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      sheet().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('still closes on Escape when the focus has fallen back to the page', async () => {
    const { onClose } = mount(makeFakeTrainerController({ clips: [] }));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(sheet().contains(document.activeElement)).toBe(false);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves the focus to the new content when a step finishes, never leaving it on the page', async () => {
    const { ctl } = controllerReading({ 'a.wav': fakePrepared({ name: 'a.wav' }) });
    mount(ctl);
    await choose(audioFile('a.wav'));
    expect(sheet().contains(document.activeElement)).toBe(true);
    // The review starts at its heading, so a screen reader announces the new clip.
    expect(document.activeElement?.textContent).toBe('Check this clip');
    await tickAndSave();
    expect(sheet().contains(document.activeElement)).toBe(true);
  });

  it('turns away files that are not audio or video and says what is accepted', async () => {
    const { ctl } = controllerReading({});
    mount(ctl);
    await choose(new File(['x'], 'notes.txt', { type: 'text/plain' }), new File(['x'], 'photo.jpg', { type: 'image/jpeg' }));
    expect(ctl.prepareClip).not.toHaveBeenCalled();
    const err = $('.field-error').textContent ?? '';
    expect(err).toContain('"notes.txt", "photo.jpg" do not look like audio or video');
    expect(err).toMatch(/WAV, MP3, M4A/);
    expect($('input[type="file"]')).toBeTruthy(); // still on the picking step
  });

  it('accepts a phone video by its extension even when the browser gives no type', async () => {
    const { ctl } = controllerReading({ 'IMG_0042.MOV': fakePrepared({ name: 'IMG_0042.MOV' }) });
    mount(ctl);
    await choose(new File(['x'], 'IMG_0042.MOV', { type: '' }));
    expect(ctl.prepareClip).toHaveBeenCalledTimes(1);
  });

  it('waits for a library that is still opening, and explains one that is broken or temporary', () => {
    mount(makeFakeTrainerController({ clips: [], status: 'loading' }));
    expect(text()).toMatch(/Opening your library/);
    expect($<HTMLInputElement>('input[type="file"]').disabled).toBe(true);
    expect(text()).toMatch(/Waiting for the library to open/);
    act(() => root.unmount());
    root = createRoot(container);

    mount(makeFakeTrainerController({ clips: [], status: 'error', error: 'IndexedDB is blocked.' }));
    expect(text()).toMatch(/The library is not available.*IndexedDB is blocked.*Reload the app/);
    expect($<HTMLInputElement>('input[type="file"]').disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);

    mount(makeFakeTrainerController({ clips: [], status: 'memory-only' }));
    expect(text()).toMatch(/Clips will be lost when you close the app/);
    expect($<HTMLInputElement>('input[type="file"]').disabled).toBe(false);
  });

  it('starts straight away with files that were dropped on the library', () => {
    const { ctl } = controllerReading({ 'dropped.wav': fakePrepared() });
    mount(ctl, { initialFiles: [audioFile('dropped.wav')] });
    expect(ctl.prepareClip).toHaveBeenCalledTimes(1);
  });
});

describe('ImportSheet: one clip from file to library', () => {
  it('shows progress while the file is read, then the review, then saves and says it is done', async () => {
    const prepared = fakePrepared({ name: 'Chorus.wav' });
    const { ctl, releases } = controllerReading({ 'Chorus.wav': prepared }, { hold: true });
    const { onClose, onSaved } = mount(ctl);
    await choose(audioFile('Chorus.wav'));

    expect(text()).toContain('Chorus.wav');
    expect(text()).toMatch(/Listening for the melody/);
    const bar = $('[role="progressbar"]');
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(61); // analysing 0.5 -> 0.3 + 0.62 * 0.5 = 0.61
    expect($$('.rev')).toHaveLength(0);

    await act(async () => releases['Chorus.wav']());
    expect($$('.rev')).toHaveLength(1);
    expect(text()).toMatch(/Check this clip/);
    expect(text()).toMatch(/3 phrases to practise/);
    expect(hasButton(/Skip this file/)).toBe(false); // nothing to skip to with one file

    await tickAndSave();
    expect(ctl.calls).toContain('commitClip');
    expect(ctl.clips).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0].id).toBe(ctl.clips[0].id);
    expect(text()).toMatch(/Added 1 clip/);
    expect(text()).toMatch(/ready to practise/);
    expect($('.imp-heading').textContent).toBe('Finished');

    click(button(/^Done$/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('remembers that the user confirmed ownership, so the next clip starts ticked', async () => {
    const { ctl } = controllerReading({ 'a.wav': fakePrepared({ name: 'a.wav' }), 'b.wav': fakePrepared({ name: 'b.wav' }) });
    mount(ctl);
    await choose(audioFile('a.wav'));
    await tickAndSave();
    expect(localStorage.getItem('mimic:v1:trainer-owned')).toBe('1');
    click(button(/Add more clips/));
    await choose(audioFile('b.wav'));
    const owned = $$<HTMLInputElement>('.rev-section input[type="checkbox"]').pop()!;
    expect(owned.checked).toBe(true);
    expect(button(/Save clip/).disabled).toBe(false);
  });

  it('passes the user\'s edits to the library', async () => {
    const { ctl } = controllerReading({ 'a.wav': fakePrepared({ name: 'a.wav' }) });
    mount(ctl);
    await choose(audioFile('a.wav'));
    click($$('.rev-chip input')[0]);
    click(button(/Merge with next/));
    await tickAndSave();
    expect(ctl.clips[0]).toMatchObject({ title: 'a', singerId: 'shawn-mendes', kind: 'solo' });
    expect(ctl.clips[0].phrases).toHaveLength(2);
  });

  it('keeps the review open with the reason and a way to retry when the library cannot store the clip', async () => {
    const { ctl } = controllerReading({ 'a.wav': fakePrepared({ name: 'a.wav' }) });
    const real = ctl.commitClip;
    let attempts = 0;
    ctl.commitClip = vi.fn(async (...args: Parameters<typeof real>) => {
      attempts++;
      if (attempts === 1) throw new QuotaError('Not enough room on this device (needs about 6 MB).');
      if (attempts === 2) throw new StoreUnavailableError('This browser does not offer IndexedDB.');
      return real(...args);
    });
    mount(ctl);
    await choose(audioFile('a.wav'));
    await tickAndSave();
    expect(text()).toMatch(/The clip was not saved/);
    expect(text()).toMatch(/Not enough room on this device.*Remove clips you no longer practise.*keep a shorter part/);
    expect(button(/Save clip/).disabled).toBe(false);
    await clickAsync(button(/Save clip/));
    expect(text()).toMatch(/does not offer IndexedDB.*Reload the app.*export a backup/);
    await clickAsync(button(/Save clip/));
    expect(text()).toMatch(/Added 1 clip/);
    expect(ctl.commitClip).toHaveBeenCalledTimes(3);
  });
});

describe('ImportSheet: several files', () => {
  it('reads the next file while the first is being reviewed, shows the queue, and skips', async () => {
    const { ctl, order } = controllerReading({ 'one.wav': fakePrepared({ name: 'one.wav' }), 'two.wav': fakePrepared({ name: 'two.wav' }), 'three.wav': fakePrepared({ name: 'three.wav' }) });
    const { onSaved } = mount(ctl);
    await choose(audioFile('one.wav'), audioFile('two.wav'), audioFile('three.wav'));
    expect(order).toEqual(['one.wav', 'two.wav']); // the third waits its turn
    expect($$('.imp-queue-item')).toHaveLength(3);
    expect($$('.imp-queue-item')[0].textContent).toMatch(/one\.wav.*ready/);
    expect($$('.imp-queue-item')[2].textContent).toMatch(/three\.wav.*waiting/);
    expect(text()).toMatch(/Clip 1 of 3/);

    await tickAndSave();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['one.wav', 'two.wav', 'three.wav']);
    expect(text()).toMatch(/Clip 2 of 3/);
    expect($('.rev-file-name').textContent).toBe('two.wav');

    await clickAsync(button(/Skip this file/));
    expect($('.rev-file-name').textContent).toBe('three.wav');
    await clickAsync(button(/Skip this file/));
    expect(text()).toMatch(/Added 1 clip/);
    const results = $$('.imp-results li').map((li) => li.textContent);
    expect(results[0]).toMatch(/one.*saved, 3 phrases/);
    expect(results[1]).toMatch(/two\.wav.*left out/);
    expect(results[2]).toMatch(/three\.wav.*left out/);
  });

  it('shows a file that cannot be read with the fix, and moves on to the next', async () => {
    const { ctl } = controllerReading({
      'Song.m4p': new Error('"Song.m4p" is copy-protected, so this app cannot read it. Use a DRM-free copy of a song you own.'),
      'ok.wav': fakePrepared({ name: 'ok.wav' }),
    });
    mount(ctl);
    await choose(audioFile('Song.m4p'), audioFile('ok.wav'));
    const alert = $('.notice--error');
    expect(alert.textContent).toMatch(/Could not use Song\.m4p/);
    expect(alert.textContent).toMatch(/copy-protected.*DRM-free copy of a song you own/);
    expect(alert.getAttribute('role')).toBe('alert');
    await clickAsync(button(/Continue with the next file/));
    expect($('.rev-file-name').textContent).toBe('ok.wav');
    await tickAndSave();
    expect(text()).toMatch(/Added 1 clip/);
    const results = $$('.imp-results li');
    expect(results[0].textContent).toMatch(/Song\.m4p.*problem.*copy-protected/);
    expect(results[1].textContent).toMatch(/saved/);
  });

  it('lets the user choose different files after a failure', async () => {
    const { ctl } = controllerReading({ 'bad.wav': new Error('"bad.wav" is empty.') });
    mount(ctl);
    await choose(audioFile('bad.wav'));
    expect(text()).toMatch(/"bad.wav" is empty/);
    expect(hasButton(/Continue with the next file/)).toBe(false);
    click(button(/Choose different files/));
    expect($('input[type="file"]')).toBeTruthy();
    expect($$('.imp-queue')).toHaveLength(0);
  });

  it('ignores a file that finishes reading after it was skipped', async () => {
    const { ctl, releases } = controllerReading({ 'slow.wav': fakePrepared({ name: 'slow.wav' }), 'next.wav': fakePrepared({ name: 'next.wav' }) }, { hold: true });
    mount(ctl);
    await choose(audioFile('slow.wav'), audioFile('next.wav'));
    await clickAsync(button(/Skip this file/));
    await act(async () => releases['next.wav']());
    expect($('.rev-file-name').textContent).toBe('next.wav');
    await act(async () => releases['slow.wav']());
    expect($('.rev-file-name').textContent).toBe('next.wav');
    expect($$('.rev')).toHaveLength(1);
  });

  it('asks before closing with unsaved clips, and closes at once when everything is saved', async () => {
    const { ctl } = controllerReading({ 'a.wav': fakePrepared({ name: 'a.wav' }), 'b.wav': fakePrepared({ name: 'b.wav' }) });
    const { onClose } = mount(ctl);
    await choose(audioFile('a.wav'), audioFile('b.wav'));
    click(button(/^Close$/));
    expect(onClose).not.toHaveBeenCalled();
    expect($('[aria-label="Confirm closing"]').textContent).toMatch(/2 files have not been saved yet\. Close and leave them out\?/);
    click(button(/Keep going/));
    expect($$('[aria-label="Confirm closing"]')).toHaveLength(0);
    act(() => {
      sheet().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    click(button(/Close without saving/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ImportSheet: files already in the library', () => {
  it('offers to re-attach the audio when the file belongs to a clip that lost it', async () => {
    const lost = makeFakeClip({ id: 'lost', title: 'Old verse', audioMissing: true, fingerprint: '2000000:22000:0123456789abcdef' });
    const ctl = makeFakeTrainerController({ clips: [lost] });
    ctl.prepareClip = vi.fn(async () => fakePrepared({ name: 'Old verse.wav', fingerprint: '2000000:22000:0123456789abcdef' }));
    const { onSaved } = mount(ctl);
    await choose(audioFile('Old verse.wav'));
    expect($('.notice--info').textContent).toMatch(/This is the file for "Old verse"/);
    await clickAsync(button(/Re-attach the audio/));
    expect(ctl.calls).toContain('relinkClip');
    expect(ctl.calls).not.toContain('commitClip');
    expect(ctl.clips[0].audioMissing).toBe(false);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/Old verse.*audio re-attached/);
  });

  it('warns, but does not stop the user, when the file is already in the library with its audio', async () => {
    const have = makeFakeClip({ id: 'have', title: 'Chorus', fingerprint: '2000000:22000:0123456789abcdef' });
    const ctl = makeFakeTrainerController({ clips: [have] });
    ctl.prepareClip = vi.fn(async () => fakePrepared({ name: 'Chorus.wav', fingerprint: '2000000:22000:0123456789abcdef@5000' }));
    mount(ctl);
    await choose(audioFile('Chorus.wav'));
    expect($('.notice--warn').textContent).toMatch(/Already in your library as "Chorus"/);
    expect(hasButton(/Re-attach the audio/)).toBe(false);
    await tickAndSave();
    expect(ctl.calls).toContain('commitClip');
  });
});

describe('ImportSheet: giving a clip its audio back', () => {
  const lostClip = () => makeFakeClip({ id: 'lost', title: 'Old verse', sourceFileName: 'Old verse.wav', audioMissing: true, fingerprint: '2000000:22000:0123456789abcdef', durationSec: 22 });

  it('asks for the one file, attaches it when it matches, and leaves the phrases alone', async () => {
    const ctl = makeFakeTrainerController({ clips: [lostClip()] });
    ctl.prepareClip = vi.fn(async () => fakePrepared({ name: 'Old verse.wav', fingerprint: '2000000:22000:0123456789abcdef' }));
    const { onSaved, onClose } = mount(ctl, { relinkClipId: 'lost' });
    expect($('.imp-heading').textContent).toBe('Add the file again');
    expect(text()).toMatch(/Pick the file you originally added for Old verse \(Old verse\.wav\)/);
    expect($<HTMLInputElement>('input[type="file"]').multiple).toBe(false);
    expect(text()).not.toMatch(/Get a file into Files/);

    await choose(audioFile('Old verse.wav'));
    expect(ctl.calls).toContain('relinkClip');
    expect(ctl.calls).not.toContain('commitClip');
    expect($$('.rev')).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(text()).toMatch(/The audio is back/);
    expect(hasButton(/Add more clips/)).toBe(false);
    click(button(/^Done$/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that is not the one, and lets the user choose again', async () => {
    const ctl = makeFakeTrainerController({ clips: [lostClip()] });
    ctl.prepareClip = vi.fn(async () => fakePrepared({ name: 'Different.wav', durationSec: 40, fingerprint: '1:2:other' }));
    mount(ctl, { relinkClipId: 'lost' });
    await choose(audioFile('Different.wav'));
    expect(text()).toMatch(/does not look like the file for "Old verse" \(Old verse\.wav\)/);
    expect(ctl.calls).not.toContain('relinkClip');
    click(button(/Choose different files/));
    expect($('input[type="file"]')).toBeTruthy();
  });

  it('says so when the clip is no longer in the library', () => {
    mount(makeFakeTrainerController({ clips: [] }), { relinkClipId: 'gone' });
    expect(text()).toMatch(/That clip is no longer in the library/);
    expect($$('input[type="file"]')).toHaveLength(0);
  });

  it('shows what went wrong when the library refuses the audio', async () => {
    const ctl = makeFakeTrainerController({ clips: [lostClip()] });
    ctl.prepareClip = vi.fn(async () => fakePrepared({ name: 'Old verse.wav', fingerprint: '2000000:22000:0123456789abcdef' }));
    ctl.relinkClip = vi.fn(async () => {
      throw new Error('Not enough room on this device.');
    });
    mount(ctl, { relinkClipId: 'lost' });
    await choose(audioFile('Old verse.wav'));
    expect(text()).toMatch(/Could not use Old verse\.wav/);
    expect(text()).toMatch(/Not enough room on this device/);
  });
});

describe('ImportSheet with the real import code and a store', () => {
  // The controller is the fake one for everything but reading and storing, which run the real modules on synthetic audio.
  async function realController(analyzeCalls: (string | undefined)[] = []) {
    const { createMemoryClipStore } = await import('../../storage/clips');
    const { analyzeTake } = await import('../../analysis/analyze');
    const { commitClip, prepareClip } = await import('../../trainer/import');
    const store = createMemoryClipStore();
    const ctl = makeFakeTrainerController({ clips: [] });
    const settings = { voiceType: 'baritone' as const, a4Hz: 440, anthropicApiKey: null, aiModel: 'x' };
    const analyze = async (s: Float32Array, sr: number, opts: Parameters<typeof analyzeTake>[2], onProgress?: (f: number) => void) => {
      analyzeCalls.push(opts.mode);
      return analyzeTake(s, sr, { ...opts, mode: undefined }, onProgress);
    };
    ctl.prepareClip = (file, onProgress) => prepareClip(file, settings, onProgress, { deps: { analyze } });
    ctl.commitClip = async (prepared, edits, onProgress) => {
      const { clip } = await commitClip(prepared, edits, store, onProgress);
      ctl.clips = [clip, ...ctl.clips];
      return clip;
    };
    return { ctl, store };
  }

  it('imports a synthetic solo melody, lets the phrases be edited, and stores the clip with its audio', async () => {
    const { wavFile, soloLine, KIT_RATE } = await import('../../trainer/importTestKit');
    const { ctl, store } = await realController();
    mount(ctl);
    await choose(wavFile(soloLine({ count: 3 }), KIT_RATE, 'Three lines.wav'));
    // Reading and analysing the file takes a moment of real work.
    for (let i = 0; i < 200 && $$('.rev').length === 0; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect($$('.rev')).toHaveLength(1);
    expect(text()).toMatch(/3 phrases to practise/);
    expect($('.rev-file-name').textContent).toBe('Three lines.wav');
    expect($$('.pe-item')).toHaveLength(3);

    click(button(/Merge with next/));
    expect(text()).toMatch(/2 phrases to practise/);
    await tickAndSave();
    expect(text()).toMatch(/Added 1 clip/);

    const stored = await store.listClips();
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe('Three lines');
    expect(stored[0].phrases).toHaveLength(2);
    expect(stored[0].kind).toBe('solo');
    const audio = await store.readAudio(stored[0].id, stored[0].audio.mix, 0, 3);
    expect(audio.length).toBe(3 * KIT_RATE);
    expect(audio.some((v) => Math.abs(v) > 0.1)).toBe(true);
  }, 60000);

  it('says why a clip of speech cannot be added, and what to try, before anything is stored', async () => {
    const { wavFile, speechLike, KIT_RATE } = await import('../../trainer/importTestKit');
    const { ctl, store } = await realController();
    mount(ctl);
    await choose(wavFile(speechLike(), KIT_RATE, 'Talking.wav'));
    for (let i = 0; i < 200 && $$('.rev').length === 0; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
    expect($('.notice--error').textContent).toMatch(/speech-like syllables.*sung section/);
    expect(button(/Save clip/).disabled).toBe(true);
    expect(await store.listClips()).toEqual([]);
  }, 60000);
});

describe('helpers', () => {
  it('combines the phases of reading a file into one progress number', () => {
    const at = (phase: ImportProgress['phase'], fraction: number) => overallProgress({ fileIndex: 0, fileCount: 1, name: 'a', phase, fraction });
    expect(overallProgress(null)).toBe(0);
    expect(at('reading', 0)).toBe(0);
    expect(at('decoding', 1)).toBeCloseTo(0.3, 6);
    expect(at('analysing', 0)).toBeCloseTo(0.3, 6);
    expect(at('analysing', 1)).toBeCloseTo(0.92, 6);
    expect(at('segmenting', 1)).toBe(1);
    expect(at('analysing', 7)).toBeCloseTo(0.92, 6);
    const seq = [at('reading', 1), at('decoding', 0.5), at('decoding', 1), at('analysing', 0.3), at('analysing', 1), at('segmenting', 1)];
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  it('turns store failures into messages that say what to do next', () => {
    expect(saveErrorMessage(new QuotaError('Not enough room.'))).toMatch(/Not enough room\. Remove clips/);
    expect(saveErrorMessage(new StoreUnavailableError('No IndexedDB.'))).toMatch(/No IndexedDB\. Reload the app/);
    expect(saveErrorMessage(new Error('boom'))).toBe('boom');
    expect(saveErrorMessage('x')).toMatch(/could not be saved/);
  });
});
