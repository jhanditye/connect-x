import { describe, expect, it } from 'vitest';
import { desktopBrowser, isDesktopKind, platformKind, type PlatformEnv } from './platform';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  // iPadOS 13+ in desktop mode: says Macintosh, but has a touch screen.
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // Apple Silicon Chrome still says "Intel Mac OS X".
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  macEdge: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  jsdom: 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/30.1.1',
};

const env = (userAgent: string, platform: string, maxTouchPoints = 0): PlatformEnv => ({ userAgent, platform, maxTouchPoints, standaloneFlag: undefined, displayModeStandalone: false });

describe('platformKind', () => {
  it('recognises an iPhone and an iPad in desktop mode as ios, never as a Mac', () => {
    expect(platformKind(env(UA.iphoneSafari, 'iPhone', 5))).toBe('ios');
    expect(platformKind(env(UA.ipadDesktopMode, 'MacIntel', 5))).toBe('ios');
  });

  it('recognises a Mac in Safari, Chrome, Edge and Firefox (Apple Silicon reports Intel)', () => {
    for (const ua of [UA.macSafari, UA.macChrome, UA.macEdge, UA.macFirefox]) expect(platformKind(env(ua, 'MacIntel', 0))).toBe('mac');
  });

  it('recognises other desktops', () => {
    expect(platformKind(env(UA.winChrome, 'Win32'))).toBe('desktop');
    expect(platformKind(env(UA.linuxChrome, 'Linux x86_64'))).toBe('desktop');
  });

  it('keeps the phone wording for Android, a test DOM and an unreadable user agent', () => {
    expect(platformKind(env(UA.androidChrome, 'Linux armv8l', 5))).toBe('other');
    expect(platformKind(env(UA.jsdom, ''))).toBe('other');
    expect(platformKind(env('', ''))).toBe('other');
  });

  it('says which kinds are a computer', () => {
    expect(isDesktopKind('mac')).toBe(true);
    expect(isDesktopKind('desktop')).toBe(true);
    expect(isDesktopKind('ios')).toBe(false);
    expect(isDesktopKind('other')).toBe(false);
  });
});

describe('desktopBrowser', () => {
  it('tells Safari from the Chrome family and Firefox', () => {
    expect(desktopBrowser(env(UA.macSafari, 'MacIntel'))).toBe('safari');
    expect(desktopBrowser(env(UA.macChrome, 'MacIntel'))).toBe('chrome');
    expect(desktopBrowser(env(UA.macEdge, 'MacIntel'))).toBe('edge');
    expect(desktopBrowser(env(UA.macFirefox, 'MacIntel'))).toBe('firefox');
    expect(desktopBrowser(env(UA.winChrome, 'Win32'))).toBe('chrome');
  });
});
