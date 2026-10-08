import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepScreenAwake } from './wakeLock';

afterEach(() => vi.unstubAllGlobals());

describe('keepScreenAwake', () => {
  it('requests a screen lock and releases it', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release, addEventListener: vi.fn() }));
    vi.stubGlobal('navigator', { wakeLock: { request } });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const lock = keepScreenAwake();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    lock.release();
    expect(release).toHaveBeenCalled();
  });

  it('does nothing when unsupported or refused', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', {});
    expect(() => keepScreenAwake().release()).not.toThrow();
    vi.stubGlobal('navigator', {
      wakeLock: {
        request: vi.fn(async () => {
          throw new Error('NotAllowedError');
        }),
      },
    });
    const lock = keepScreenAwake();
    await Promise.resolve();
    expect(() => lock.release()).not.toThrow();
  });
});
