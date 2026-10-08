// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainerExtrasContext, type TrainerExtras } from '../../state/TrainerProvider';
import { makeFakeClip, makeFakeTrainerController, type FakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import { loadTrainerPrefs } from '../trainerPrefs';
import { TrainerSettings } from './TrainerSettings';

const saveFile = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('./download', async (orig) => ({ ...(await orig<typeof import('./download')>()), saveFile: (...a: unknown[]) => saveFile(...a) }));

const screen = useScreen();
beforeEach(() => saveFile.mockClear());

function settings(ctl: FakeTrainerController = makeFakeTrainerController(), extras: Partial<TrainerExtras> = {}) {
  const e: TrainerExtras = {
    memoryReason: null,
    warnings: [],
    exportReminder: { due: false, message: null },
    storageNote: null,
    reload: () => Promise.resolve(),
    refreshStorage: () => Promise.resolve(ctl.storage),
    requestPersistence: () => Promise.resolve(true),
    ...extras,
  };
  screen.mount(
    <TrainerExtrasContext.Provider value={e}>
      <TrainerSettings />
    </TrainerExtrasContext.Provider>,
    ctl,
  );
  return { ctl, extras: e };
}
const choose = async (select: HTMLSelectElement, value: string) =>
  act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
const status = (name: RegExp) => screen.qa('.status-row').find((r) => name.test(r.querySelector('dt')?.textContent ?? ''))!.querySelector('dd')!;

describe('Settings: Trainer section', () => {
  it('says where the clips live, how many there are, and how much room they take', () => {
    settings();
    expect(screen.q('#trainer-heading').textContent).toBe('Trainer');
    expect(screen.text()).toMatch(/kept on this device only/);
    expect(status(/Library/).textContent).toBe('1 clip, 12 phrases');
    expect(status(/Space used/).textContent).toMatch(/118 MB.*of about 5\.6 GB/);
    expect(status(/Space used/).querySelector('.st-meter')?.getAttribute('aria-label')).toBe('2 percent of the space this site may use');
  });

  it('warns that a memory-only library is lost when the app closes', () => {
    settings(makeFakeTrainerController({ status: 'memory-only' }));
    expect(status(/Library/).textContent).toMatch(/Lost when you close the app/);
  });

  it('says whether the browser will keep the clips, and asks it to when it has not agreed', async () => {
    const requestPersistence = vi.fn(() => Promise.resolve(true));
    const refreshStorage = vi.fn(() => Promise.resolve({ supported: true, usage: 1, quota: 2, persisted: true }));
    const ctl = makeFakeTrainerController();
    settings(ctl, { requestPersistence, refreshStorage, storageNote: 'Add Mimic to your Home Screen to keep your clips.' });
    expect(status(/Kept safe/).textContent).toMatch(/Best effort/);
    expect(screen.text()).toMatch(/Home Screen/);
    await screen.clickAsync(screen.button(/Ask the browser to keep my clips/));
    expect(requestPersistence).toHaveBeenCalledOnce();
    expect(refreshStorage).toHaveBeenCalledOnce();
    ctl.storage = { ...ctl.storage, persisted: true };
    settings(ctl);
    expect(status(/Kept safe/).textContent).toBe('Persistent');
    expect(screen.hasButton(/Ask the browser/)).toBe(false);
  });

  it('shows unknown storage as unknown, not as zero', () => {
    const ctl = makeFakeTrainerController();
    ctl.storage = { supported: false, usage: null, quota: null, persisted: null };
    settings(ctl);
    expect(status(/Space used/).textContent).toBe('unknown');
    expect(status(/Kept safe/).textContent).toBe('Unknown');
    expect(screen.has('.st-meter')).toBe(false);
  });
});

describe('Settings: Trainer practice choices', () => {
  it('starting speed, count-in and how a visit starts are saved on this device', async () => {
    settings();
    const [speed, count, start] = screen.qa<HTMLSelectElement>('select');
    expect(Array.from(speed.options).map((o) => o.textContent)).toEqual(['100%', '90%', '75%', '60%', '50% (rough)']);
    await choose(speed, '0.75');
    await choose(count, '4');
    await choose(start, 'turn-taking');
    expect(loadTrainerPrefs()).toMatchObject({ defaultRate: 0.75, countInBeats: 4, startMode: 'turn-taking' });
  });

  it('keeping recordings is off, says what it does, and is a real switch', async () => {
    settings();
    const sw = screen.q<HTMLInputElement>('input[role="switch"]');
    expect(sw.checked).toBe(false);
    expect(screen.text()).toMatch(/never uploaded and a backup does not contain them/);
    await screen.clickAsync(sw);
    expect(loadTrainerPrefs().keepRecordings).toBe(true);
    expect(screen.q('[role="status"].visually-hidden').textContent).toMatch(/Recordings of your takes will be kept on this device, the last three per phrase\./);
    await screen.clickAsync(screen.q('input[role="switch"]'));
    expect(loadTrainerPrefs().keepRecordings).toBe(false);
    expect(screen.q('[role="status"].visually-hidden').textContent).toMatch(/no longer kept/);
  });

  it('explains why automatic only sings along with headphones', () => {
    settings();
    expect(screen.text()).toMatch(/Automatic only sings along when headphones look connected/);
  });
});

describe('Settings: Trainer backup', () => {
  it('Export saves the library as a file and says there is no audio in it', async () => {
    const { ctl } = settings();
    await screen.clickAsync(screen.button(/Export my library/));
    expect(ctl.calls).toContain('exportLibrary');
    expect(saveFile).toHaveBeenCalledOnce();
    expect(saveFile.mock.calls[0][1]).toMatch(/^mimic-library-\d{4}-\d{2}-\d{2}\.json$/);
    expect(screen.q('.notice').textContent).toMatch(/Backup saved.*no audio/);
  });

  it('a failed export says what to try', async () => {
    const { ctl } = settings();
    ctl.exportLibrary = async () => {
      throw new Error('The library is not open.');
    };
    await screen.clickAsync(screen.button(/Export my library/));
    expect(screen.q('.notice--error').textContent).toMatch(/could not be saved\. The library is not open\./);
  });

  it('Import reads a file the person picks, and says what came back and that audio is needed again', async () => {
    const { ctl } = settings();
    ctl.importLibrary = vi.fn(async () => ({ added: 2, updated: 1, warnings: ['1 practice attempt was skipped because its phrase has been edited or removed since the backup.'] }));
    const file = new File(['{}'], 'mimic-library-2026-10-01.json', { type: 'application/json' });
    const input = screen.q<HTMLInputElement>('input[type="file"]');
    expect(input.getAttribute('accept')).toBe('.json,application/json');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
    await tick();
    expect(ctl.importLibrary).toHaveBeenCalledWith(file);
    expect(screen.text()).toMatch(/Backup restored: 2 clips added, 1 updated\. Clips from a backup need their audio file added again/);
    expect(screen.text()).toMatch(/1 practice attempt was skipped/);
  });

  it('a backup with nothing new, and a file that is not a backup, are both said plainly', async () => {
    const { ctl } = settings();
    const pick = async (f: File) => {
      const input = screen.q<HTMLInputElement>('input[type="file"]');
      Object.defineProperty(input, 'files', { value: [f], configurable: true });
      await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })));
      await tick();
    };
    ctl.importLibrary = async () => ({ added: 0, updated: 0, warnings: [] });
    await pick(new File(['{}'], 'a.json'));
    expect(screen.text()).toMatch(/holds nothing new, so nothing changed/);
    ctl.importLibrary = async () => {
      throw new Error('That is not a Mimic backup. Choose the .json file made with "Export library".');
    };
    await pick(new File(['nope'], 'b.json'));
    expect(screen.q('.notice--error').textContent).toMatch(/not a Mimic backup/);
  });

  it('cannot export or import while the library is not open, and the label is still reachable', () => {
    settings(makeFakeTrainerController({ status: 'loading', clips: [] }));
    expect(screen.button(/Export my library/).disabled).toBe(true);
    expect(screen.q<HTMLInputElement>('input[type="file"]').disabled).toBe(true);
  });
});

describe('Settings: Trainer device checks and delete', () => {
  it('opens the device checks on request and hides them again', () => {
    settings();
    expect(screen.has('.st-diag')).toBe(false);
    screen.click(screen.button(/Open the device checks/));
    expect(screen.has('.st-diag')).toBe(true);
    expect(screen.q('.st-diag').textContent).toMatch(/Run|checks|report/i);
    screen.click(screen.button(/Hide the device checks/));
    expect(screen.has('.st-diag')).toBe(false);
  });

  it('a #settings/diagnostics link opens them straight away', () => {
    window.location.hash = '#settings/diagnostics';
    settings();
    expect(screen.has('.st-diag')).toBe(true);
    expect(screen.button(/Hide the device checks/).getAttribute('aria-expanded')).toBe('true');
  });

  it('delete asks first in the page; Cancel puts focus back on the button', async () => {
    const { ctl } = settings();
    screen.click(screen.button(/Delete all clips and scores/));
    expect(screen.q('.confirm').textContent).toMatch(/Delete every clip, phrase, practice score and kept recording from this device\?.*Export a backup first.*cannot be undone/s);
    expect(document.activeElement?.textContent).toBe('Cancel');
    await screen.clickAsync(screen.button('Cancel'));
    expect(ctl.calls).not.toContain('clearAll');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.button(/Delete all clips and scores/));
  });

  it('Yes deletes everything and says what to do next, with focus on that message', async () => {
    const { ctl } = settings();
    screen.click(screen.button(/Delete all clips and scores/));
    await screen.clickAsync(screen.button(/Yes, delete the Trainer data/));
    expect(ctl.calls).toContain('clearAll');
    expect(ctl.clips).toHaveLength(0);
    const note = screen.qa('p[role="status"]').find((p) => /Trainer data deleted/.test(p.textContent ?? ''))!;
    expect(note.textContent).toBe('Trainer data deleted. Add a clip in the Trainer to start again.');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(note);
    expect(status(/Library/).textContent).toBe('0 clips, 0 phrases');
  });

  it('a delete that fails says so and leaves the clips', async () => {
    const { ctl } = settings(makeFakeTrainerController({ clips: [makeFakeClip()] }));
    ctl.clearAll = async () => {
      throw new Error('The library is not open. Reload the app and try again.');
    };
    screen.click(screen.button(/Delete all clips and scores/));
    await screen.clickAsync(screen.button(/Yes, delete the Trainer data/));
    expect(screen.q('.notice--error').textContent).toMatch(/not open/);
    expect(ctl.clips).toHaveLength(1);
  });

  it('renders nothing without a Trainer', () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const root = createRoot(holder);
    act(() => root.render(<TrainerSettings />));
    expect(holder.innerHTML).toBe('');
    act(() => root.unmount());
    holder.remove();
  });
});
