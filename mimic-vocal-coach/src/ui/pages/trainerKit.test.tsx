// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeProfile } from '../../testing/fixtures';
import { makeFakeClip } from '../../testing/trainerFixtures';
import { downloadLibraryBackup, groupClips, singerName, singerOf, useFocusOnMount } from './trainerKit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveFile = vi.fn(async (..._a: unknown[]): Promise<boolean | undefined> => undefined);
vi.mock('../components/download', async (orig) => ({ ...(await orig<typeof import('../components/download')>()), saveFile: (...a: unknown[]) => saveFile(...a) }));
beforeEach(() => saveFile.mockClear());
afterEach(() => vi.restoreAllMocks());

const singers = [
  makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes' }),
  makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar' }),
  makeFakeProfile({ id: 'jalen-ngonda', name: 'Jalen Ngonda' }),
];

describe('groupClips', () => {
  it('puts the builtin singers first in their order, then others by the name typed, and leaves out empty groups', () => {
    const clips = [
      makeFakeClip({ id: 'a', singerId: null, singerLabel: 'Zed' }),
      makeFakeClip({ id: 'b', singerId: 'jalen-ngonda' }),
      makeFakeClip({ id: 'c', singerId: null, singerLabel: 'Alicia' }),
      makeFakeClip({ id: 'd', singerId: 'shawn-mendes' }),
      makeFakeClip({ id: 'e', singerId: null, singerLabel: ' alicia ' }),
      makeFakeClip({ id: 'f', singerId: null, singerLabel: '' }),
      makeFakeClip({ id: 'g', singerId: 'unknown-singer', singerLabel: '' }),
    ];
    const groups = groupClips(clips, singers);
    expect(groups.map((g) => g.name)).toEqual(['Shawn Mendes', 'Jalen Ngonda', 'Zed', 'Alicia', 'Someone else']);
    expect(groups.find((g) => g.name === 'Alicia')?.clips.map((c) => c.id)).toEqual(['c', 'e']);
    expect(groups.find((g) => g.name === 'Someone else')?.clips.map((c) => c.id)).toEqual(['f', 'g']);
    expect(groups[0].singer?.id).toBe('shawn-mendes');
    expect(groups[2].singer).toBeNull();
  });

  it('is empty for no clips', () => {
    expect(groupClips([], singers)).toEqual([]);
  });
});

describe('singerOf and singerName', () => {
  it('find the singer, the typed name, or "Someone else"', () => {
    expect(singerOf(makeFakeClip({ singerId: 'daniel-caesar' }), singers)?.name).toBe('Daniel Caesar');
    expect(singerOf(makeFakeClip({ singerId: null }), singers)).toBeNull();
    expect(singerOf(makeFakeClip({ singerId: 'gone' }), singers)).toBeNull();
    expect(singerName(makeFakeClip({ singerId: 'daniel-caesar' }), singers)).toBe('Daniel Caesar');
    expect(singerName(makeFakeClip({ singerId: null, singerLabel: ' Alicia ' }), singers)).toBe('Alicia');
    expect(singerName(makeFakeClip({ singerId: null, singerLabel: '' }), singers)).toBe('Someone else');
  });
});

describe('useFocusOnMount', () => {
  function mount(enabled: boolean) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    function Page() {
      const ref = useFocusOnMount<HTMLHeadingElement>(enabled);
      return (
        <h1 ref={ref} tabIndex={-1}>
          Title
        </h1>
      );
    }
    act(() => root.render(<Page />));
    return { container, unmount: () => (act(() => root.unmount()), container.remove()) };
  }

  it('focuses the heading and scrolls to the top when enabled', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const m = mount(true);
    expect(document.activeElement).toBe(m.container.querySelector('h1'));
    expect(scroll).toHaveBeenCalledWith({ top: 0 });
    m.unmount();
  });

  it('leaves focus alone when not enabled (the first screen of a visit)', () => {
    const m = mount(false);
    expect(document.activeElement).toBe(document.body);
    m.unmount();
  });

  it('survives a browser that cannot scroll', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      throw new Error('not implemented');
    });
    const m = mount(true);
    expect(document.activeElement).toBe(m.container.querySelector('h1'));
    m.unmount();
  });
});

describe('downloadLibraryBackup', () => {
  it('saves the export under a dated file name and says there is no audio in it', async () => {
    const blob = new Blob(['{}'], { type: 'application/json' });
    const r = await downloadLibraryBackup({ exportLibrary: async () => blob });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no audio/);
    expect(saveFile).toHaveBeenCalledWith(blob, expect.stringMatching(/^mimic-library-\d{4}-\d{2}-\d{2}\.json$/));
  });

  it('counts the backup as made only after the file was saved', async () => {
    const markExported = vi.fn(async () => undefined);
    const exportLibrary = vi.fn(async (_o?: { markDone?: boolean }) => new Blob(['{}']));
    const ok = await downloadLibraryBackup({ exportLibrary, markExported });
    expect(ok.ok).toBe(true);
    expect(exportLibrary).toHaveBeenCalledWith({ markDone: false });
    expect(markExported).toHaveBeenCalledTimes(1);
  });

  it('leaves the reminder on when the share sheet was closed or the save failed', async () => {
    const markExported = vi.fn(async () => undefined);
    const exportLibrary = async () => new Blob(['{}']);
    saveFile.mockResolvedValueOnce(false);
    const closed = await downloadLibraryBackup({ exportLibrary, markExported });
    expect(closed.ok).toBe(false);
    expect(closed.message).toMatch(/share sheet was closed.*Save to Files/);
    saveFile.mockRejectedValueOnce(new Error('No room'));
    const failed = await downloadLibraryBackup({ exportLibrary, markExported });
    expect(failed.ok).toBe(false);
    expect(markExported).not.toHaveBeenCalled();
  });

  it('with a controller that cannot defer, the export itself marks the backup', async () => {
    const exportLibrary = vi.fn(async (_o?: { markDone?: boolean }) => new Blob(['{}']));
    await downloadLibraryBackup({ exportLibrary });
    expect(exportLibrary).toHaveBeenCalledWith({ markDone: true });
  });

  it('never rejects: a failure becomes a sentence that says what to try', async () => {
    const r = await downloadLibraryBackup({
      exportLibrary: async () => {
        throw new Error('The library is not open.');
      },
    });
    expect(r).toEqual({ ok: false, message: 'The backup could not be saved. The library is not open. Try again, or reload the app first.' });
    saveFile.mockRejectedValueOnce(new Error('Share cancelled'));
    const r2 = await downloadLibraryBackup({ exportLibrary: async () => new Blob(['x']) });
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/Share cancelled/);
    const r3 = await downloadLibraryBackup({
      exportLibrary: async () => {
        throw 'weird';
      },
    });
    expect(r3.message).toBe('The backup could not be saved. Try again, or reload the app first.');
  });
});
