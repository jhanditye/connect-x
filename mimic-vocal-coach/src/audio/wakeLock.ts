// Keeps the screen on while a take is being recorded. iOS locks the screen after 30 s to 5 min of no
// touches (Auto-Lock), and a locked or backgrounded page stops getting microphone audio. Screen Wake Lock
// is in Safari 16.4+ and works in Home Screen web apps only from iOS 18.4 (WebKit bug 254545: before that the call can succeed and
// do nothing), so there it is not requested and not claimed. In a Safari tab it works on any supported iOS, but Safari grants it
// only within about 5 s of a touch: call keepScreenAwake() inside the tap, before awaiting anything slow (a permission sheet, a decode).
// Unsupported or refused: no-op.

import { isIos, isStandalone, readEnv } from '../pwa/platform';

export interface ScreenWakeLock {
  release(): void;
}

/** The iOS version in a user-agent string ("CPU iPhone OS 17_5 like Mac OS X"), as [major, minor]; null when it does not say. */
export function iosVersionOf(userAgent: string): [number, number] | null {
  const m = /OS (\d+)[_.](\d+)/.exec(userAgent);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * True where the lock is known to do nothing: an installed Home Screen app on iOS before 18.4. False means "try it" (it may
 * still be refused); an unreadable version counts as not known to be broken.
 */
export function wakeLockKnownBroken(): boolean {
  try {
    const env = readEnv();
    if (!isIos(env) || !isStandalone(env)) return false;
    const v = iosVersionOf(env.userAgent);
    return v !== null && (v[0] < 18 || (v[0] === 18 && v[1] < 4));
  } catch {
    return false;
  }
}

export function keepScreenAwake(): ScreenWakeLock {
  let sentinel: WakeLockSentinel | null = null;
  let wanted = true;
  const nav = (typeof navigator === 'undefined' ? undefined : navigator) as Navigator | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  const acquire = async () => {
    if (!wanted || sentinel || !nav?.wakeLock || !visible() || wakeLockKnownBroken()) return;
    try {
      const s = await nav.wakeLock.request('screen');
      if (!wanted) {
        void s.release().catch(() => undefined);
        return;
      }
      sentinel = s;
      s.addEventListener?.('release', () => {
        if (sentinel === s) sentinel = null;
      });
    } catch {
      // Refused (low-power mode, hidden page): recording still works, the screen may just dim and lock.
    }
  };

  // The system releases the lock whenever the page is hidden; take it again when the page returns.
  const onVisibility = () => {
    if (visible()) void acquire();
  };
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisibility);
  void acquire();

  return {
    release() {
      wanted = false;
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisibility);
      const s = sentinel;
      sentinel = null;
      void s?.release().catch(() => undefined);
    },
  };
}
