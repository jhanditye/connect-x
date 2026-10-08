import { describe, expect, it } from 'vitest';
import { detectNative, installHelp, iosBrowser, isIos, isNativeApp, isStandalone, readEnv, type PlatformEnv } from './platform';

const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const CHROME_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.122 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22G86 Instagram 380.0.0.28.104 (iPhone15,2)';
const IPADOS_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

function env(over: Partial<PlatformEnv>): PlatformEnv {
  return { userAgent: SAFARI_IPHONE, platform: 'iPhone', maxTouchPoints: 5, standaloneFlag: false, displayModeStandalone: false, ...over };
}

describe('isIos', () => {
  it('recognises iPhone, and iPadOS reporting itself as a touch Mac', () => {
    expect(isIos(env({}))).toBe(true);
    expect(isIos(env({ userAgent: IPADOS_DESKTOP, platform: 'MacIntel', maxTouchPoints: 5 }))).toBe(true);
  });
  it('does not treat a real Mac or Android as iOS', () => {
    expect(isIos(env({ userAgent: IPADOS_DESKTOP, platform: 'MacIntel', maxTouchPoints: 0 }))).toBe(false);
    expect(isIos(env({ userAgent: CHROME_ANDROID, platform: 'Linux armv8l' }))).toBe(false);
  });
});

describe('isStandalone', () => {
  it('uses navigator.standalone or the display-mode media query', () => {
    expect(isStandalone(env({}))).toBe(false);
    expect(isStandalone(env({ standaloneFlag: true }))).toBe(true);
    expect(isStandalone(env({ standaloneFlag: undefined, displayModeStandalone: true }))).toBe(true);
  });
});

describe('iosBrowser', () => {
  it('tells Safari from other iOS browsers and in-app views', () => {
    expect(iosBrowser(env({}))).toBe('safari');
    expect(iosBrowser(env({ userAgent: CHROME_IPHONE }))).toBe('chrome');
    expect(iosBrowser(env({ userAgent: INSTAGRAM }))).toBe('in-app');
  });
});

describe('installHelp', () => {
  it('shows on iOS in a browser tab, hides when installed or not on iOS', () => {
    expect(installHelp(env({})).show).toBe(true);
    expect(installHelp(env({ standaloneFlag: true })).show).toBe(false);
    expect(installHelp(env({ userAgent: CHROME_ANDROID, platform: 'Linux armv8l' })).show).toBe(false);
  });
  it('asks in-app browser users to open the page in Safari', () => {
    expect(installHelp(env({ userAgent: INSTAGRAM })).needsSafari).toBe(true);
    expect(installHelp(env({})).needsSafari).toBe(false);
    expect(installHelp(env({ userAgent: CHROME_IPHONE })).needsSafari).toBe(false);
  });
});

describe('the Capacitor app (ios-native/)', () => {
  // Its web view has no navigator.standalone and a user agent without the "Safari/" token.
  const WKWEBVIEW = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const native = env({ userAgent: WKWEBVIEW, standaloneFlag: undefined, native: true });

  it('counts as an installed app, so the Install card never shows inside it', () => {
    expect(isNativeApp(native)).toBe(true);
    expect(isStandalone(native)).toBe(true);
    expect(installHelp(native).show).toBe(false);
    expect(installHelp(native).needsSafari).toBe(false);
    // The same web view without the flag looks like an unknown iOS browser: that was the problem.
    const without = env({ userAgent: WKWEBVIEW, standaloneFlag: undefined });
    expect(installHelp(without)).toMatchObject({ show: true, needsSafari: true });
  });

  it('is not guessed from a plain browser', () => {
    expect(isNativeApp(env({}))).toBe(false);
    expect(detectNative()).toBe(false);
  });

  it('is detected from window.Capacitor or the capacitor: scheme', () => {
    const g = globalThis as { Capacitor?: unknown };
    g.Capacitor = { isNativePlatform: () => true };
    try {
      expect(detectNative()).toBe(true);
      expect(readEnv().native).toBe(true);
      g.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
      expect(detectNative()).toBe(false);
      g.Capacitor = { getPlatform: () => 'ios' };
      expect(detectNative()).toBe(true);
    } finally {
      delete g.Capacitor;
    }
  });
});
