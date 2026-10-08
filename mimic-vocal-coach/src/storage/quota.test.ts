import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkImportSpace, estimateImportBytes, formatBytes, getStorageStatus, isInstalledPwa, requestPersistence, storageNote, UNKNOWN_STORAGE, type StorageStatus } from './quota';

const MB = 1e6;
const GB = 1e9;

function stubStorage(storage: Partial<StorageManager> | undefined, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('navigator', { storage, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('getStorageStatus', () => {
  it('reports nothing known when the browser has no storage manager', async () => {
    vi.stubGlobal('navigator', {});
    expect(await getStorageStatus()).toEqual(UNKNOWN_STORAGE);
    vi.stubGlobal('navigator', undefined);
    expect(await getStorageStatus()).toEqual(UNKNOWN_STORAGE);
  });

  it('reads usage, quota and persistence', async () => {
    stubStorage({ estimate: async () => ({ usage: 124 * MB, quota: 6 * GB }), persisted: async () => true, persist: async () => true });
    expect(await getStorageStatus()).toEqual({ supported: true, usage: 124 * MB, quota: 6 * GB, persisted: true });
  });

  it('keeps going when one call throws', async () => {
    stubStorage({
      estimate: async () => {
        throw new Error('blocked');
      },
      persisted: async () => false,
    });
    expect(await getStorageStatus()).toEqual({ supported: true, usage: null, quota: null, persisted: false });
    stubStorage({ estimate: async () => ({ usage: 1, quota: 2 }), persisted: () => Promise.reject(new Error('blocked')) });
    expect(await getStorageStatus()).toEqual({ supported: true, usage: 1, quota: 2, persisted: null });
  });

  it('does not trust junk numbers', async () => {
    stubStorage({ estimate: (async () => ({ usage: -5, quota: 'lots' })) as unknown as StorageManager['estimate'] });
    expect(await getStorageStatus()).toMatchObject({ usage: null, quota: null });
    stubStorage({ estimate: async () => ({ usage: NaN, quota: Infinity }) });
    expect(await getStorageStatus()).toMatchObject({ usage: null, quota: null });
  });

  it('is supported with only persist() (Safari 15 and 16)', async () => {
    stubStorage({ persist: async () => true });
    expect(await getStorageStatus()).toEqual({ supported: true, usage: null, quota: null, persisted: null });
  });

  it('gives up on a call that never answers', async () => {
    vi.useFakeTimers();
    stubStorage({ estimate: () => new Promise<StorageEstimate>(() => {}), persisted: () => new Promise<boolean>(() => {}) });
    const pending = getStorageStatus();
    await vi.advanceTimersByTimeAsync(9000);
    expect(await pending).toEqual({ supported: true, usage: null, quota: null, persisted: null });
  });
});

describe('requestPersistence', () => {
  it('is false without a storage manager or persist()', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistence()).toBe(false);
    stubStorage({ estimate: async () => ({}) });
    expect(await requestPersistence()).toBe(false);
  });

  it('asks the browser and returns its answer', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: async () => false, persist });
    expect(await requestPersistence()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    stubStorage({ persisted: async () => false, persist: async () => false });
    expect(await requestPersistence()).toBe(false);
  });

  it('does not ask again when the data is already protected', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persisted: async () => true, persist });
    expect(await requestPersistence()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('is false when the call throws', async () => {
    stubStorage({
      persist: () => {
        throw new Error('not allowed');
      },
    });
    expect(await requestPersistence()).toBe(false);
  });
});

describe('formatBytes', () => {
  it('prints short human sizes', () => {
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(NaN)).toBe('unknown');
    expect(formatBytes(-1)).toBe('unknown');
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(412_000)).toBe('412 KB');
    expect(formatBytes(5_500_000)).toBe('5.5 MB');
    expect(formatBytes(124_000_000)).toBe('124 MB');
    expect(formatBytes(1.234e9)).toBe('1.2 GB');
  });
});

describe('import space check', () => {
  const status = (usage: number | null, quota: number | null): StorageStatus => ({ supported: true, usage, quota, persisted: null });

  it('sizes a clip from its frames, doubled with a stem', () => {
    expect(estimateImportBytes(240 * 44100)).toBe(240 * 44100 * 2);
    expect(estimateImportBytes(1000, { stem: true })).toBe(4000);
    expect(estimateImportBytes(-1)).toBe(0);
  });

  it('passes a clip that fits easily', () => {
    expect(checkImportSpace(22 * MB, status(100 * MB, 6 * GB))).toMatchObject({ level: 'ok', message: null });
  });

  it('warns above 80 percent of what is left and names the next step', () => {
    const r = checkImportSpace(85 * MB, status(0, 100 * MB));
    expect(r.level).toBe('tight');
    expect(r.message).toMatch(/Trim it/);
    expect(r.freeBytes).toBe(100 * MB);
  });

  it('refuses a clip that cannot fit, and says when a lower rate would', () => {
    const lowerFits = checkImportSpace(100 * MB, status(0, 90 * MB));
    expect(lowerFits.level).toBe('insufficient');
    expect(lowerFits.suggestLowerRate).toBe(true);
    expect(lowerFits.message).toMatch(/100 MB/);
    const hopeless = checkImportSpace(100 * MB, status(95 * MB, 100 * MB));
    expect(hopeless.level).toBe('insufficient');
    expect(hopeless.suggestLowerRate).toBe(false);
    expect(hopeless.message).toMatch(/Remove clips/);
  });

  it('cannot judge when the browser does not report free space', () => {
    expect(checkImportSpace(22 * MB, status(null, null))).toMatchObject({ level: 'unknown', message: null, freeBytes: null });
    expect(checkImportSpace(22 * MB, UNKNOWN_STORAGE).level).toBe('unknown');
  });

  it('treats an over-full origin as zero free and nothing needed as fine', () => {
    expect(checkImportSpace(1, status(200, 100)).level).toBe('insufficient');
    expect(checkImportSpace(0, status(0, 10)).level).toBe('ok');
    expect(checkImportSpace(NaN, status(0, 10)).level).toBe('ok');
  });
});

describe('install and notes', () => {
  it('detects the Home Screen app on iOS and by display mode', () => {
    vi.stubGlobal('navigator', { standalone: true });
    expect(isInstalledPwa()).toBe(true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('standalone') }));
    expect(isInstalledPwa()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isInstalledPwa()).toBe(false);
    vi.stubGlobal('matchMedia', () => {
      throw new Error('no');
    });
    expect(isInstalledPwa()).toBe(false);
    vi.stubGlobal('matchMedia', undefined);
    expect(isInstalledPwa()).toBe(false);
  });

  const base: StorageStatus = { supported: true, usage: 100 * MB, quota: 6 * GB, persisted: true };

  it('says the clips will be lost in memory-only mode', () => {
    expect(storageNote(base, { memoryOnly: true, installed: true })).toMatch(/lost when you close/);
  });

  it('tells a browser tab to install, once the data is not protected', () => {
    expect(storageNote({ ...base, persisted: false }, { memoryOnly: false, installed: false })).toMatch(/Home Screen/);
    expect(storageNote({ ...base, persisted: null }, { memoryOnly: false, installed: false })).toMatch(/Home Screen/);
    expect(storageNote(base, { memoryOnly: false, installed: false })).toBeNull();
    expect(storageNote({ ...base, persisted: false }, { memoryOnly: false, installed: true })).toBeNull();
  });

  it('warns when the device is nearly full', () => {
    expect(storageNote({ ...base, usage: 5.8 * GB }, { memoryOnly: false, installed: true })).toMatch(/nearly full/);
  });
});
