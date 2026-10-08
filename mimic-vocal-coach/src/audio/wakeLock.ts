// Keeps the screen on while a take is being recorded. iOS locks the screen after 30 s to 5 min of no
// touches (Auto-Lock), and a locked or backgrounded page stops getting microphone audio. Screen Wake Lock
// is in Safari 16.4+ and works in Home Screen web apps from iOS 18.4. Unsupported or refused: no-op.

export interface ScreenWakeLock {
  release(): void;
}

export function keepScreenAwake(): ScreenWakeLock {
  let sentinel: WakeLockSentinel | null = null;
  let wanted = true;
  const nav = (typeof navigator === 'undefined' ? undefined : navigator) as Navigator | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  const acquire = async () => {
    if (!wanted || sentinel || !nav?.wakeLock || !visible()) return;
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
