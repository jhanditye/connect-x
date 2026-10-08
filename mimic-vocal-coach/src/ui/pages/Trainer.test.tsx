// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainerExtrasContext, type TrainerExtras } from '../../state/TrainerProvider';
import { FAKE_NOW, makeFakeClip, makeFakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import { clearPendingImport, peekPendingImport } from '../trainerHandoff';
import { TrainerPage } from './Trainer';

const saveFile = vi.fn(async () => undefined);
vi.mock('../components/download', async (orig) => ({ ...(await orig<typeof import('../components/download')>()), saveFile: (...a: unknown[]) => (saveFile as (...x: unknown[]) => Promise<void>)(...a) }));

const screen = useScreen();
beforeEach(() => {
  saveFile.mockClear();
  clearPendingImport();
});

function library() {
  const base = makeFakeClip();
  const daniel = makeFakeClip({ id: 'clip-daniel', title: 'Best Part, vocal stem', singerId: 'daniel-caesar' });
  const mix = makeFakeClip({ id: 'clip-jalen', title: 'Full song, chorus', singerId: 'jalen-ngonda', kind: 'mix' });
  const other = makeFakeClip({ id: 'clip-other', title: 'A friend singing', singerId: null, singerLabel: 'Alicia' });
  const missing = makeFakeClip({ id: 'clip-missing', title: 'Restored from a backup', audioMissing: true });
  return makeFakeTrainerController({ clips: [base, daniel, mix, other, missing] });
}
const page = (ctl = library(), extras?: Partial<TrainerExtras>) => {
  const inert: TrainerExtras = {
    memoryReason: null,
    warnings: [],
    exportReminder: { due: false, message: null },
    storageNote: null,
    reload: () => Promise.resolve(),
    refreshStorage: () => Promise.resolve({ supported: true, usage: 1, quota: 2, persisted: false }),
    requestPersistence: () => Promise.resolve(true),
    ...extras,
  };
  return screen.mount(
    <TrainerExtrasContext.Provider value={inert}>
      <TrainerPage now={FAKE_NOW} />
    </TrainerExtrasContext.Provider>,
    ctl,
  );
};
const groupNames = () => screen.qa('.tr-group-name').map((e) => e.textContent?.trim());

describe('Trainer library', () => {
  it('lists clips grouped by singer, builtin singers first, then everyone else', () => {
    page();
    expect(screen.q('h1').textContent).toBe('Practise with the voices you love');
    expect(groupNames()).toEqual(['Shawn Mendes', 'Daniel Caesar', 'Jalen Ngonda', 'Alicia']);
    const titles = screen.qa('.cc-title').map((e) => e.textContent);
    expect(titles).toEqual(['Fake clip, 12 phrases', 'Restored from a backup', 'Best Part, vocal stem', 'Full song, chorus', 'A friend singing']);
    expect(screen.qa('a.cc').map((a) => a.getAttribute('href'))).toContain('#trainer/c/clip-daniel');
    expect(screen.text()).toContain('Full song');
    expect(screen.text()).toContain('Needs the file again');
  });

  it('shows today\'s queue as cards that open the phrase, with the reason and the status in words', () => {
    page();
    const cards = screen.qa<HTMLAnchorElement>('.tq');
    expect(cards).toHaveLength(3);
    expect(cards[0].getAttribute('href')).toMatch(/^#trainer\/c\/fake-clip\/p\/\d+$/);
    expect(cards[0].textContent).toMatch(/Review, 3 days overdue/);
    expect(cards[0].textContent).toMatch(/Review due/);
    expect(screen.text()).toMatch(/and 2 more after these/);
    expect(screen.link(/Start with the first/).getAttribute('href')).toBe(cards[0].getAttribute('href'));
  });

  it('says so, and names the next step, when nothing is due', () => {
    const ctl = library();
    ctl.queue = [];
    page(ctl);
    expect(screen.has('.tr-today')).toBe(false);
    expect(screen.text()).toMatch(/Nothing is due today\. Open any clip below and pick a phrase, or add another clip\./);
  });

  it('says which clips need their audio file again, how to add it, and that scores stay', () => {
    page();
    const note = screen.q('.notice--warn');
    expect(note.textContent).toMatch(/One clip needs its audio file again/);
    expect(note.textContent).toMatch(/never audio/);
    expect(note.textContent).toMatch(/recognises each one by its\s+contents/);
    expect(note.textContent).toMatch(/phrases and scores stay exactly as they were/);
    expect(note.querySelector('ul')?.textContent).toContain('Restored from a backup');
    screen.click(screen.button(/Choose the files/));
    expect(window.location.hash).toBe('#trainer/add');
  });

  it('has no such note when every clip has its audio, and says nothing can be practised when none has', () => {
    page(makeFakeTrainerController());
    expect(screen.text()).not.toMatch(/needs? (its|their) audio files? again/);
    screen.unmount();
    const ctl = makeFakeTrainerController({ clips: [makeFakeClip({ audioMissing: true }), makeFakeClip({ id: 'b', audioMissing: true })] });
    ctl.queue = [];
    page(ctl);
    expect(screen.text()).toMatch(/2 clips need their audio files again/);
    expect(screen.text()).toMatch(/Nothing can be practised until the audio files are added again\./);
  });

  it('filters by singer with real toggle buttons, and All brings everyone back', () => {
    page();
    const chip = (name: RegExp) => screen.qa<HTMLButtonElement>('.tr-filter .tr-chip').find((b) => name.test(b.textContent ?? ''))!;
    expect(chip(/^All/).getAttribute('aria-pressed')).toBe('true');
    screen.click(chip(/Daniel/));
    expect(groupNames()).toEqual(['Daniel Caesar']);
    expect(chip(/Daniel/).getAttribute('aria-pressed')).toBe('true');
    expect(chip(/^All/).getAttribute('aria-pressed')).toBe('false');
    screen.click(chip(/^All/));
    expect(groupNames()).toHaveLength(4);
  });

  it('offers no filter when there is only one singer', () => {
    page(makeFakeTrainerController());
    expect(screen.has('.tr-filter')).toBe(false);
    expect(groupNames()).toEqual(['Shawn Mendes']);
  });

  it('shows the storage line and the storage note', () => {
    page(library(), { storageNote: 'Add Mimic to your Home Screen to keep your clips.' });
    expect(screen.q('.tr-storage').textContent).toMatch(/118 MB on this device of about 5\.6 GB\./);
    expect(screen.q('.tr-storage').textContent).toMatch(/Home Screen/);
  });

  it('Add clips is a big button that opens the add sheet through the URL, and closing it goes back', async () => {
    page();
    screen.click(screen.button(/Add clips/));
    expect(window.location.hash).toBe('#trainer/add');
    await screen.go('#trainer/add');
    expect(document.querySelector('.imp-sheet')).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('.imp-sheet button[aria-label*="Close"], .imp-sheet .imp-close')?.click());
    await tick();
    expect(window.location.hash).toBe('#trainer');
  });
});

describe('Trainer library: empty, loading, error', () => {
  it('an empty library explains how to get a vocal and offers Add clips and the Studio', () => {
    page(makeFakeTrainerController({ clips: [] }));
    expect(screen.has('.te')).toBe(true);
    expect(screen.has('.tr-clips')).toBe(false);
    expect(screen.has('.tr-dock')).toBe(false);
    expect(screen.text()).toMatch(/Voice Memos/);
    expect(screen.text()).toMatch(/Record a free take in the Studio/);
    screen.click(screen.button(/Add clips/));
    expect(window.location.hash).toBe('#trainer/add');
  });

  it('loading says so and shows neither the empty state nor clips', () => {
    page(makeFakeTrainerController({ status: 'loading', clips: [] }));
    expect(screen.q('.tr-loading').textContent).toBe('Opening your library…');
    expect(screen.has('.te')).toBe(false);
    expect(screen.has('.tr-clips')).toBe(false);
  });

  it('a library that cannot be opened says why, and offers a retry, a reload and the Studio', () => {
    const reload = vi.fn(() => Promise.resolve());
    page(makeFakeTrainerController({ status: 'error', error: 'The place where clips are kept did not answer.', clips: [] }), { reload });
    const n = screen.q('.notice--error');
    expect(n.getAttribute('role')).toBe('alert');
    expect(n.textContent).toMatch(/could not be opened/);
    expect(n.textContent).toMatch(/did not answer/);
    screen.click(screen.button(/Try again/));
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.button(/Reload the app/)).toBeTruthy();
    expect(screen.link(/Go to the Studio/).getAttribute('href')).toBe('#studio');
    expect(screen.has('.te')).toBe(false);
  });

  it('memory-only mode warns that clips will be lost, and offers a backup when there are clips', async () => {
    const ctl = makeFakeTrainerController({ status: 'memory-only', clips: [makeFakeClip()] });
    page(ctl, { memoryReason: 'This browser blocks storage in a private window.' });
    const n = screen.q('.notice--warn');
    expect(n.textContent).toMatch(/Clips will be lost when you close the app/);
    expect(n.textContent).toMatch(/blocks storage in a private window/);
    await screen.clickAsync(screen.button(/Back up my library/));
    expect(ctl.calls).toContain('exportLibrary');
    expect(saveFile).toHaveBeenCalledOnce();
    expect(screen.text()).toMatch(/Backup saved/);
    expect(screen.text()).toMatch(/no audio/);
  });

  it('memory-only with no clips still lets you add one', () => {
    page(makeFakeTrainerController({ status: 'memory-only', clips: [] }));
    expect(screen.has('.te')).toBe(true);
    expect(screen.hasButton(/Back up my library/)).toBe(false);
    expect((screen.q('.te-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a failed backup says what to try', async () => {
    const ctl = makeFakeTrainerController({ status: 'memory-only', clips: [makeFakeClip()] });
    ctl.exportLibrary = async () => {
      throw new Error('The library is not open.');
    };
    page(ctl);
    await screen.clickAsync(screen.button(/Back up my library/));
    expect(screen.q('.notice--error').textContent).toMatch(/could not be saved\. The library is not open\. Try again, or reload the app first/);
  });
});

describe('Trainer library: reminders and warnings', () => {
  it('shows a backup reminder as a banner with a button, and what could not be read', async () => {
    const ctl = library();
    page(ctl, { exportReminder: { due: true, message: '12 practice attempts since your last backup. Export your library to keep your history safe.' }, warnings: ['1 saved clip could not be read and is hidden.'] });
    expect(screen.text()).toMatch(/A backup is worth making/);
    expect(screen.text()).toMatch(/1 saved clip could not be read/);
    await screen.clickAsync(screen.button(/Back up my library/));
    expect(ctl.calls).toContain('exportLibrary');
  });

  it('shows no reminder when none is due', () => {
    page();
    expect(screen.text()).not.toMatch(/backup is worth making/);
  });
});

describe('Trainer library: dropping files', () => {
  function drop(files: File[], types = ['Files']) {
    const target = screen.q('.page--trainer');
    const event = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types, files }, configurable: true });
      return e;
    };
    act(() => void target.dispatchEvent(event('dragenter')));
    return { over: target.classList.contains('tr--over'), drop: () => act(() => void target.dispatchEvent(event('drop'))) };
  }

  it('highlights the page while files are over it, and hands audio files to the add sheet', () => {
    page();
    const wav = new File(['x'], 'verse.wav', { type: 'audio/wav' });
    const notes = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const d = drop([wav, notes]);
    expect(d.over).toBe(true);
    d.drop();
    expect(screen.q('.page--trainer').classList.contains('tr--over')).toBe(false);
    expect(window.location.hash).toBe('#trainer/add');
    expect(peekPendingImport()).toEqual([wav]);
  });

  it('ignores a drop with no audio in it, and drags that carry no files', () => {
    page();
    drop([new File(['x'], 'notes.txt', { type: 'text/plain' })]).drop();
    expect(window.location.hash).toBe('');
    expect(peekPendingImport()).toEqual([]);
    expect(drop([], ['text/plain']).over).toBe(false);
  });
});

describe('Trainer: moving between screens', () => {
  it('opens a clip from its link, and moves focus to the clip\'s heading', async () => {
    page();
    expect(document.activeElement).toBe(document.body);
    await screen.go('#trainer/c/clip-daniel');
    expect(screen.q('h1').textContent).toBe('Best Part, vocal stem');
    expect(document.activeElement).toBe(screen.q('h1'));
  });

  it('coming back to the library puts focus on its heading', async () => {
    window.location.hash = '#trainer/c/clip-daniel';
    page();
    await screen.go('#trainer');
    expect(screen.q('h1').textContent).toBe('Practise with the voices you love');
    expect(document.activeElement).toBe(screen.q('h1'));
  });

  it('a malformed trainer link opens the library', () => {
    window.location.hash = '#trainer/c';
    page();
    expect(screen.q('h1').textContent).toBe('Practise with the voices you love');
  });
});
