import { afterEach, describe, expect, it, vi } from 'vitest';
import { iosVersionOf, keepScreenAwake, wakeLockKnownBroken } from './wakeLock';

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

const IPHONE = (v: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${v} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1`;

describe('a Home Screen app before iOS 18.4', () => {
  const home = (v: string, standalone: boolean) => {
    vi.stubGlobal('navigator', { userAgent: IPHONE(v), platform: 'iPhone', maxTouchPoints: 5, standalone });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
  };

  it('reads the iOS version from the user agent', () => {
    expect(iosVersionOf(IPHONE('17_5'))).toEqual([17, 5]);
    expect(iosVersionOf(IPHONE('18_4_1'))).toEqual([18, 4]);
    expect(iosVersionOf('Mozilla/5.0 (X11; Linux x86_64)')).toBeNull();
  });

  it('is known not to work there (WebKit bug 254545), but does in a Safari tab and from 18.4', () => {
    home('17_5', true);
    expect(wakeLockKnownBroken()).toBe(true);
    home('18_3', true);
    expect(wakeLockKnownBroken()).toBe(true);
    home('18_4', true);
    expect(wakeLockKnownBroken()).toBe(false);
    home('17_5', false); // a Safari tab
    expect(wakeLockKnownBroken()).toBe(false);
  });

  it('is not requested there, instead of pretending it holds the screen', async () => {
    home('17_5', true);
    const request = vi.fn(async () => ({ release: vi.fn(async () => undefined), addEventListener: vi.fn() }));
    vi.stubGlobal('navigator', { userAgent: IPHONE('17_5'), platform: 'iPhone', maxTouchPoints: 5, standalone: true, wakeLock: { request } });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const lock = keepScreenAwake();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(() => lock.release()).not.toThrow();
  });
});
