// Plain-English numbers for the Skills screens and findings.

/** True minus sign, the same character as MINUS in src/ui/charts/chartKit.ts (kept local so scoring stays UI-free). */
export const MINUS = '−';

/** "+12 cents", "−8 cents", "0 cents", "+1 cent"; "–" for a missing number. */
export function formatCents(c: number): string {
  if (!Number.isFinite(c)) return '–';
  const a = Math.round(Math.abs(c));
  if (a === 0) return '0 cents';
  return `${c > 0 ? '+' : MINUS}${a} ${a === 1 ? 'cent' : 'cents'}`;
}

const FRACTIONS: readonly [number, string][] = [
  [5, 'a twentieth of a semitone'],
  [10, 'a tenth of a semitone'],
  [20, 'a fifth of a semitone'],
  [25, 'a quarter of a semitone'],
  [33, 'a third of a semitone'],
  [50, 'half a semitone'],
  [67, 'two thirds of a semitone'],
  [75, 'three quarters of a semitone'],
  [100, 'a whole semitone'],
];

/** "25 cents is a quarter of a semitone", "12 cents is about a tenth of a semitone", "250 cents is about 2.5 semitones". */
export function centsMeaning(c: number): string {
  if (!Number.isFinite(c)) return '';
  const a = Math.round(Math.abs(c));
  if (a === 0) return 'spot on: 0 cents';
  if (a <= 2) return `${a} ${a === 1 ? 'cent is' : 'cents are'} too small to hear`;
  if (a <= 110) {
    let best = FRACTIONS[0];
    for (const f of FRACTIONS) if (Math.abs(f[0] - a) < Math.abs(best[0] - a)) best = f;
    return `${a} cents is ${best[0] === a ? '' : 'about '}${best[1]}`;
  }
  const st = Math.round(a / 10) / 10;
  return `${a} cents is ${Number.isInteger(st) ? '' : 'about '}${st} semitones`;
}

/** "15 cents flat" / "20 cents sharp" / "right on" (rounded). */
export function sharpFlat(c: number): string {
  const a = Math.round(Math.abs(c));
  if (a === 0) return 'right on pitch';
  return `${a} ${a === 1 ? 'cent' : 'cents'} ${c > 0 ? 'sharp' : 'flat'}`;
}
