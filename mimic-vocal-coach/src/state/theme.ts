// Theme preference. AppSettings has no theme field, so it is stored on its own key. 'system'
// removes data-theme so tokens.css follows prefers-color-scheme.

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'mimic.theme';

export function loadTheme(): ThemePref {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(t: ThemePref): void {
  try {
    if (t === 'system') globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, t);
  } catch {
    // Storage unavailable (private mode, sandboxed frame): the choice lasts for this visit only.
  }
}

export function applyTheme(t: ThemePref, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}
