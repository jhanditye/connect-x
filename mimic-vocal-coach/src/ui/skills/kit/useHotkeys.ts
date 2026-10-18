// Keyboard shortcuts for the Skills screens on a Mac keyboard: Space = play / replay, Return = start / next, number keys
// = answers. Keys are ignored while a text field, select or slider has focus, with a modifier held (Cmd+R must still
// reload), and when a button or link has focus and the key would press it (Return/Space): the native press wins.

import { useEffect, useRef } from 'react';

export type HotkeyMap = Partial<Record<string, () => void>>;

/** True when the key event should be left alone (typing, modifiers, or it would activate the focused control). */
export function ignoreHotkey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return true;
  const t = e.target as HTMLElement | null;
  if (!t || typeof t.closest !== 'function') return false;
  if (t.closest('input, textarea, select, [contenteditable="true"]')) return true;
  if ((e.key === 'Enter' || e.key === ' ') && t.closest('button, a[href], summary, [role="button"], [role="radio"]')) return true;
  return false;
}

/** Normalised key name: "Space", "Enter", "1".."9", "0", "-", "=" or the key itself. */
export function hotkeyName(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (e.key === ' ' || e.code === 'Space') return 'Space';
  if (e.key === 'Enter') return 'Enter';
  return e.key;
}

/** Listens on the window while `enabled`; the latest map is always used (no stale closures). */
export function useHotkeys(enabled: boolean, map: HotkeyMap): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (ignoreHotkey(e)) return;
      const fn = ref.current[hotkeyName(e)];
      if (!fn) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** The key that answers choice number `i` (0-based): 1..9, then 0, -, = (the top row of a keyboard). */
export const ANSWER_KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
