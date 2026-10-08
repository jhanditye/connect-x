import { describe, expect, it, vi } from 'vitest';
import { formatBytes, readStorageStatus, requestPersistence } from './storage';

describe('readStorageStatus', () => {
  it('reports persistence and usage', async () => {
    const s = await readStorageStatus({
      persisted: vi.fn(async () => true),
      persist: vi.fn(async () => true),
      estimate: vi.fn(async () => ({ usage: 5 * 1048576, quota: 8 * 1073741824 })),
    });
    expect(s).toEqual({ api: true, persisted: true, usageBytes: 5 * 1048576, quotaBytes: 8 * 1073741824 });
  });

  it('survives missing or failing APIs', async () => {
    expect(await readStorageStatus(undefined)).toEqual({ api: false, persisted: null, usageBytes: null, quotaBytes: null });
    const s = await readStorageStatus({
      persisted: vi.fn(async () => {
        throw new Error('x');
      }),
      persist: vi.fn(),
      estimate: vi.fn(async () => {
        throw new Error('y');
      }),
    });
    expect(s).toEqual({ api: true, persisted: null, usageBytes: null, quotaBytes: null });
  });
});

describe('requestPersistence', () => {
  it('returns the browser answer, null when unsupported or throwing', async () => {
    expect(await requestPersistence({ persisted: vi.fn(), estimate: vi.fn(), persist: vi.fn(async () => false) })).toBe(false);
    expect(await requestPersistence(undefined)).toBeNull();
    expect(
      await requestPersistence({
        persisted: vi.fn(),
        estimate: vi.fn(),
        persist: vi.fn(async () => {
          throw new Error('no');
        }),
      }),
    ).toBeNull();
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(null)).toBe('unknown');
    expect(formatBytes(300 * 1024)).toBe('300 KB');
    expect(formatBytes(2.5 * 1048576)).toBe('2.5 MB');
    expect(formatBytes(120 * 1048576)).toBe('120 MB');
    expect(formatBytes(3 * 1073741824)).toBe('3.0 GB');
  });
});
