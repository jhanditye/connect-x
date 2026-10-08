// Optional real-voice regression clips for the scorer tests. The clips are a cappella singing and speech that live outside the
// repository (they are never copied into it); a test that needs one is skipped cleanly when the file is not there.
// Set MIMIC_REAL_VOICE_DIR to point at another folder of 16-bit WAV files.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../../audio/wav';

const DEFAULT_DIR = '/tmp/claude-0/-home-user-connect-x/c7cf0764-cfef-502f-8c42-ff240fdbd2b3/scratchpad/review/real-voice/wav';

export const REAL_VOICE_DIR = process.env.MIMIC_REAL_VOICE_DIR || DEFAULT_DIR;

/** True when every named file exists. */
export function hasRealVoice(...names: string[]): boolean {
  return names.every((n) => existsSync(join(REAL_VOICE_DIR, n)));
}

/** Mono samples of a clip, at most `maxSeconds` long. Throws when the file is missing: guard with hasRealVoice. */
export function loadRealVoice(name: string, maxSeconds?: number): { samples: Float32Array; sampleRate: number } {
  const b = readFileSync(join(REAL_VOICE_DIR, name));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const w = decodeWav(ab, { mono: true, maxSeconds });
  return { samples: w.channels[0], sampleRate: w.sampleRate };
}
