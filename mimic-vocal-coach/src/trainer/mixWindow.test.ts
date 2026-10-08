import { describe, expect, it } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { makeSongStems, mixSong, rawPitchAccuracy } from '../testing/songMix';

// The trainer reads one phrase at a time: a few seconds cut out of the stored song, analysed as a mix on their own. These
// check that reading a window gives the melody the whole-song reading gave for the same stretch (no warm-up loss at the cut).

describe('a phrase window of a full song, analysed on its own', () => {
  const stems = makeSongStems({ sampleRate: 22050 });
  const song = mixSong(stems, 0, { seconds: 32, stereo: true });
  const opts = { voiceType: 'tenor', mode: 'mix' } as const;
  const f0Of = (frames: { voiced: boolean; f0: number }[]) => frames.map((f) => (f.voiced ? f.f0 : NaN));

  it('follows the voice as well as the whole-song reading does for the same stretch', () => {
    const whole = analyzeTake(song.mono, song.sampleRate, opts);
    const wholeF0 = f0Of(whole.frames);
    for (const [a, b] of [
      [0, 7.4],
      [7.5, 15.2],
      [3, 9],
    ]) {
      const part = song.mono.slice(Math.round(a * song.sampleRate), Math.round(b * song.sampleRate));
      const win = analyzeTake(part, song.sampleRate, opts);
      expect(win.mode).toBe('mix');
      const first = Math.round(a * 100);
      const truth = song.truthHz.subarray(first, first + win.frames.length);
      const accWindow = rawPitchAccuracy(f0Of(win.frames), truth);
      const accWhole = rawPitchAccuracy(wholeF0.slice(first, first + win.frames.length), truth);
      expect(accWindow).toBeGreaterThan(0.85);
      expect(accWindow).toBeGreaterThan(accWhole - 0.05);
    }
  }, 60000);

  it('keeps the tone readings out of a window too (no tone, no onsets, a confidence)', () => {
    const part = song.mono.slice(0, Math.round(6 * song.sampleRate));
    const win = analyzeTake(part, song.sampleRate, opts);
    expect(Object.values(win.tone).every((v) => v === null)).toBe(true);
    expect(win.onsets).toEqual([]);
    expect(win.style.breathiness).toBeNull();
    expect((win as { leadExtraction?: { confidence: number } }).leadExtraction?.confidence).toBeGreaterThan(0.5);
  }, 60000);
});
