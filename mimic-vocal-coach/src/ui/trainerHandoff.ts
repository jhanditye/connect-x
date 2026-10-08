// Files handed from one screen to the Add clips sheet without putting them in the URL: dropped on the library, or made from the
// reference clip the Results page already holds. In memory only (never stored). The sheet reads them with peekPendingImport
// (safe to call on every render) and clears them when it closes.

import { encodeWav } from '../audio/wav';

let pending: File[] = [];

export function setPendingImport(files: File[]): void {
  pending = files.slice();
}

/** The waiting files, left in place. */
export function peekPendingImport(): File[] {
  return pending;
}

export function clearPendingImport(): void {
  pending = [];
}

/** The samples of a clip that is already decoded (the Studio's reference clip) as a WAV file the Add clips sheet can read, so the person need not pick it again. */
export function fileFromSamples(name: string, samples: Float32Array, sampleRate: number): File {
  const base = name.trim() || 'clip';
  const fileName = /\.wav$/i.test(base) ? base : `${base.replace(/\.[A-Za-z0-9]{2,4}$/, '')}.wav`;
  return new File([encodeWav(samples, sampleRate)], fileName, { type: 'audio/wav' });
}

/** Lower-case, no extension, single spaces: "My Song.M4A" and "my song" are the same clip name. */
export function clipNameKey(name: string): string {
  return name
    .trim()
    .replace(/\.[A-Za-z0-9]{2,4}$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
