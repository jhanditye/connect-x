// What kind of device and window the app is running in. Pure functions over a plain environment
// object, so they are testable in Node; `readEnv()` reads the real browser.

export interface PlatformEnv {
  userAgent: string;
  /** navigator.platform ("MacIntel" on iPadOS in desktop-class mode). */
  platform: string;
  maxTouchPoints: number;
  /** navigator.standalone: iOS-only, true when launched from the Home Screen. */
  standaloneFlag: boolean | undefined;
  /** matchMedia('(display-mode: standalone)').matches (also true for installed PWAs elsewhere). */
  displayModeStandalone: boolean;
  /** Running inside the Capacitor iOS app (ios-native/): the same web build in a WKWebView, no service worker, no Safari. */
  native?: boolean;
}

/**
 * True inside the Capacitor wrapper (ios-native/). Capacitor injects `window.Capacitor` before the page runs, and its web view
 * is served from the `capacitor:` scheme (or http://localhost with an Android-style config); either one is enough.
 */
export function detectNative(): boolean {
  try {
    const w = globalThis as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string }; location?: Location };
    if (w.Capacitor?.isNativePlatform?.() === true) return true;
    const platform = w.Capacitor?.getPlatform?.();
    if (platform && platform !== 'web') return true;
    return w.location?.protocol === 'capacitor:';
  } catch {
    return false;
  }
}

export function readEnv(): PlatformEnv {
  const nav = (typeof navigator === 'undefined' ? {} : navigator) as Navigator & { standalone?: boolean };
  let displayModeStandalone = false;
  try {
    displayModeStandalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    // matchMedia can throw in odd embeds; treat as "not standalone".
  }
  return {
    userAgent: nav.userAgent ?? '',
    platform: nav.platform ?? '',
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standaloneFlag: nav.standalone,
    displayModeStandalone,
    native: detectNative(),
  };
}

/** iPhone, iPod, iPad, including iPadOS 13+ which reports itself as a Mac with a touch screen. */
export function isIos(env: PlatformEnv = readEnv()): boolean {
  if (/iPhone|iPad|iPod/.test(env.userAgent)) return true;
  return env.platform === 'MacIntel' && env.maxTouchPoints > 1;
}

/** Running as the Capacitor app. */
export function isNativeApp(env: PlatformEnv = readEnv()): boolean {
  return env.native === true;
}

/** Launched from the Home Screen (or installed as an app on other platforms), or running as the native app. */
export function isStandalone(env: PlatformEnv = readEnv()): boolean {
  return env.native === true || env.standaloneFlag === true || env.displayModeStandalone;
}

export type IosBrowser = 'safari' | 'chrome' | 'firefox' | 'edge' | 'opera' | 'in-app' | 'other';

/** Which browser an iOS page is running in. Every iOS browser is WebKit; only the chrome around it differs. */
export function iosBrowser(env: PlatformEnv = readEnv()): IosBrowser {
  const ua = env.userAgent;
  if (/CriOS/.test(ua)) return 'chrome';
  if (/FxiOS/.test(ua)) return 'firefox';
  if (/EdgiOS/.test(ua)) return 'edge';
  if (/OPiOS|OPT\//.test(ua)) return 'opera';
  // In-app browsers (Instagram, Facebook, Line, TikTok, Gmail...) cannot add to the Home Screen.
  if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok|Twitter|Snapchat|GSA\//.test(ua)) return 'in-app';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export interface InstallHelp {
  /** Show the "Install on iPhone" card at all. */
  show: boolean;
  browser: IosBrowser;
  /** The tab cannot install: tell the user to open the page in Safari. */
  needsSafari: boolean;
}

export function installHelp(env: PlatformEnv = readEnv()): InstallHelp {
  const ios = isIos(env);
  const standalone = isStandalone(env);
  const browser = ios ? iosBrowser(env) : 'other';
  return { show: ios && !standalone, browser, needsSafari: ios && !standalone && (browser === 'in-app' || browser === 'other') };
}
