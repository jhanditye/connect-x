// The full-song work must not move a single number in the solo pipeline. These digests were taken from analyzeTake
// BEFORE mix mode existed (a 64-bit-ish hash of the whole analysis object, per-frame arrays included, every number at
// full precision) and are compared with what it returns now. If a change to the solo pipeline is intended, the digests
// have to be regenerated on purpose; if one of these fails after a change that was meant to touch only mix mode, that
// change broke the solo path.

import { describe, expect, it } from 'vitest';
import { makeDemoTake } from './demo';
import { mix, synthMelody, whiteNoise } from '../testing/synth';
import type { VoiceAnalysis } from '../types';
import { analyzeTake } from './analyze';

/** Two FNV-style hashes of the JSON text (non-finite numbers as strings), plus its length. */
function digest(a: VoiceAnalysis): string {
  const text = JSON.stringify(a, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}:${text.length}`;
}

describe('solo analyses are bit-for-bit what they were before mix mode', () => {
  it('the demo take (baritone)', () => {
    const demo = makeDemoTake();
    expect(digest(analyzeTake(demo.samples, demo.sampleRate, { voiceType: 'baritone' }))).toBe('8442b5c4ae6562bb:468252');
  });

  it('a sung phrase with vibrato (baritone, 22.05 kHz)', () => {
    const notes = [55, 57, 59, 62, 64, 62, 59, 57].map((midi) => ({ midi, durSec: 0.45 }));
    const x = synthMelody(notes, { sampleRate: 22050, vibrato: { rateHz: 5.5, extentCents: 30, delaySec: 0.2 } });
    expect(digest(analyzeTake(x, 22050, { voiceType: 'baritone' }))).toBe('376a62c08327c8d1:122119');
  });

  it('white noise (tenor)', () => {
    expect(digest(analyzeTake(whiteNoise(3, 0.05, 22050), 22050, { voiceType: 'tenor' }))).toBe('5487d34cd3ec87c2:70928');
  });

  it('a sung line with background noise, which the lead-vocal comparison looks at (no silence to measure SNR from) and agrees with', () => {
    // Digest taken from the code before the comparison existed: when the two trackers agree, nothing in the analysis moves.
    const notes = [55, 57, 59, 62, 64, 62, 59, 57, 55, 57, 59, 62].map((midi) => ({ midi, durSec: 0.45 }));
    const x = synthMelody(notes, { sampleRate: 22050, vibrato: { rateHz: 5.5, extentCents: 30, delaySec: 0.2 } });
    const noisy = mix(x, whiteNoise(x.length / 22050, 0.02, 22050, 11));
    const a = analyzeTake(noisy, 22050, { voiceType: 'baritone' });
    expect(a.issues).not.toContain('accompaniment');
    expect(digest(a)).toBe('bf3b6d7777b75d64:184672');
    expect(digest(analyzeTake(x, 22050, { voiceType: 'baritone' }))).toBe('3927467a26f69d8b:182722');
  });

  it('carries no mode and no lead-extraction field', () => {
    const demo = makeDemoTake(22050);
    const a = analyzeTake(demo.samples, demo.sampleRate, { voiceType: 'baritone' });
    expect('mode' in a).toBe(false);
    expect('leadExtraction' in a).toBe(false);
    const empty = analyzeTake(new Float32Array(0), 22050, { voiceType: 'baritone' });
    expect('mode' in empty).toBe(false);
  });
});
