// Singer colour mapping. Builtin profiles carry the light-theme hex in `color`; the UI uses the
// matching CSS variable instead so dark mode picks the lighter variant from tokens.css.

import type { SingerProfile } from '../../types';

const SINGER_VARS: Record<string, string> = {
  'shawn-mendes': 'var(--singer-shawn)',
  'daniel-caesar': 'var(--singer-daniel)',
  'jalen-ngonda': 'var(--singer-jalen)',
  reference: 'var(--singer-custom)',
};

/** A CSS colour for the profile, theme-aware for builtin ids and the reference profile. */
export function singerColor(profile: Pick<SingerProfile, 'id' | 'color'> | null | undefined): string {
  if (!profile) return 'var(--accent)';
  return SINGER_VARS[profile.id] ?? profile.color ?? 'var(--singer-custom)';
}

/** "Shawn Mendes" -> "Shawn"; reference names are kept whole. */
export function shortName(profile: Pick<SingerProfile, 'name' | 'source'>): string {
  if (profile.source === 'reference') return profile.name;
  return profile.name.split(/\s+/)[0] ?? profile.name;
}

/** Possessive for copy: "Shawn's", "Jalen's", "James's". */
export function possessive(name: string): string {
  return `${name}’s`;
}
