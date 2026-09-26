import { describe, expect, it } from 'vitest';
import { concat, silence, synthMelody, synthVoice } from '../testing/synth';
import { analyzeTake } from './analyze';
import type { NoteEvent } from './notes';
import { detectRuns } from './runs';

const SR = 22050;
const OPTS = { voiceType: 'baritone' as const };
const pad = () => silence(0.3, SR);

function events(spec: [number, number, number][], phraseIndex = 0): NoteEvent[] {
  // [start, end, midi]
  return spec.map(([start, end, midi]) => ({ i0: 0, i1: 0, start, end, midi, phraseIndex }));
}

describe('detectRuns', () => {
  it('needs four or more short stepped notes in a row', () => {
    const run = events([
      [0, 0.12, 60],
      [0.12, 0.24, 62],
      [0.24, 0.36, 64],
      [0.36, 0.48, 65],
      [0.48, 1.2, 67],
    ]);
    const runs = detectRuns(run);
    expect(runs).toHaveLength(1);
    expect(runs[0].noteCount).toBe(4);
    expect(runs[0].notesPerSec).toBeCloseTo(4 / 0.48, 5);
    expect(detectRuns(run.slice(0, 3))).toHaveLength(0);
  });

  it('breaks on repeated pitches, gaps and phrase boundaries', () => {
    expect(detectRuns(events([[0, 0.1, 60], [0.1, 0.2, 60.3], [0.2, 0.3, 62], [0.3, 0.4, 64]]))).toHaveLength(0);
    expect(detectRuns(events([[0, 0.1, 60], [0.1, 0.2, 62], [0.4, 0.5, 64], [0.5, 0.6, 65]]))).toHaveLength(0);
    const two = [...events([[0, 0.1, 60], [0.1, 0.2, 62]], 0), ...events([[0.2, 0.3, 64], [0.3, 0.4, 65]], 1)];
    expect(detectRuns(two)).toHaveLength(0);
  });
});

/** Contiguous events from [duration, midi] pairs. */
function chain(spec: [number, number][], phraseIndex = 0): NoteEvent[] {
  let t = 0;
  return spec.map(([d, midi]) => {
    const e = { i0: 0, i1: 0, start: t, end: t + d, midi, phraseIndex };
    t += d;
    return e;
  });
}

describe('detectRuns: glides and speed', () => {
  it('skips glide slivers between longer notes, so a syllabic melody is not a run', () => {
    // Events of a descending syllabic line in a real a cappella take: about 7 sung notes at under
    // 6/s, with 50 ms glide slivers between them. Counting the slivers made it "10 notes at 7.8/s".
    const line = events([
      [2.5, 2.71, 56],
      [2.77, 2.93, 51.6],
      [2.93, 2.98, 50.4],
      [2.98, 3.14, 48.9],
      [3.14, 3.19, 47.3],
      [3.19, 3.34, 45.5],
      [3.34, 3.41, 43],
      [3.47, 3.57, 44.1],
      [3.57, 3.73, 45],
      [3.73, 3.78, 46],
      [3.78, 4.52, 46.8],
    ]);
    expect(detectRuns(line)).toHaveLength(0);
  });

  it('a stepped passage slower than 6 notes/s is not a run', () => {
    expect(detectRuns(chain([[0.2, 60], [0.2, 62], [0.2, 64], [0.2, 65], [0.2, 67], [0.6, 65]]))).toHaveLength(0);
  });

  it('a jump wider than a fifth is not a run step (tracker jumps onto a harmonic or an instrument)', () => {
    // Events from a real take where the tracker locked onto the third harmonic for a moment.
    const jumps = events([
      [8.32, 8.42, 80.7],
      [8.42, 8.57, 79.4],
      [8.61, 8.71, 78.3],
      [8.71, 8.93, 69.3],
      [8.93, 9.01, 72.1],
      [9.01, 9.08, 90.3],
      [9.08, 9.18, 64.8],
      [9.18, 9.25, 63.6],
      [9.25, 9.9, 63.5],
    ]);
    expect(detectRuns(jumps)).toHaveLength(0);
    // A run whose last note drops an octave keeps the stepwise part.
    const drop = detectRuns(chain([[0.1, 72], [0.1, 70], [0.1, 69], [0.1, 67], [0.1, 65], [0.1, 53], [0.6, 53]]));
    expect(drop).toHaveLength(1);
    expect(drop[0].noteCount).toBe(5);
  });

  it('keeps genuinely fast runs of 60 ms notes, and bridges a sliver inside a run', () => {
    const fast = detectRuns(chain([[0.06, 60], [0.06, 62], [0.06, 64], [0.06, 65], [0.06, 67], [0.06, 65], [0.6, 64]]));
    expect(fast).toHaveLength(1);
    expect(fast[0].noteCount).toBe(6);
    expect(fast[0].notesPerSec).toBeGreaterThan(15);
    const withSliver = detectRuns(chain([[0.12, 60], [0.12, 62], [0.05, 63], [0.12, 64], [0.12, 65], [0.12, 67], [0.6, 65]]));
    expect(withSliver).toHaveLength(1);
    expect(withSliver[0].noteCount).toBe(5);
    expect(withSliver[0].notesPerSec).toBeGreaterThan(7);
  });

  it('keeps the short notes of a long-short (dotted) run', () => {
    // 150/70 ms: each short note sits between notes twice its length, like a glide sliver.
    const midis = [72, 70, 67, 65, 63, 60, 58, 55, 53];
    const dotted = detectRuns(chain(midis.map((m, k) => [k % 2 ? 0.07 : 0.15, m])));
    expect(dotted).toHaveLength(1);
    expect(dotted[0].noteCount).toBe(9);
    expect(dotted[0].notesPerSec).toBeCloseTo(9 / 1.03, 5);
  });
});

describe('runs on synthesised takes', () => {
  it('8 notes of 0.12 s make one run at ~8 notes/s', () => {
    const notes = [60, 62, 64, 65, 67, 65, 64, 62].map((midi) => ({ midi, durSec: 0.12 }));
    const a = analyzeTake(concat(pad(), synthMelody(notes, { sampleRate: SR }), pad()), SR, OPTS);
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0].noteCount).toBeGreaterThanOrEqual(7);
    expect(a.runs[0].notesPerSec).toBeGreaterThan(7);
    expect(a.runs[0].notesPerSec).toBeLessThan(9.5);
  });

  it('a dotted 9-note run (150/70 ms, 8.7 notes/s) is read at about its real speed', () => {
    const midis = [74, 72, 70, 67, 65, 63, 60, 58, 55, 53];
    const line = [...midis.map((midi, k) => ({ midi, durSec: k === 0 ? 0.8 : k % 2 ? 0.15 : 0.07 })), { midi: 53, durSec: 0.9 }];
    const phrase = (seed: number) => synthMelody(line, { sampleRate: SR, glideSec: 0.02, seed });
    const a = analyzeTake(concat(pad(), phrase(1), pad(), phrase(2), pad()), SR, OPTS);
    expect(a.runs).toHaveLength(2);
    for (const r of a.runs) expect(r.noteCount).toBeGreaterThanOrEqual(8);
    expect(a.style.agility).toBeGreaterThan(7.5);
    expect(a.style.agility).toBeLessThan(10);
  });

  it('a slow scale (0.6 s notes) has no run', () => {
    const notes = [60, 62, 64, 65, 67, 65, 64, 62].map((midi) => ({ midi, durSec: 0.6 }));
    const a = analyzeTake(concat(pad(), synthMelody(notes, { sampleRate: SR }), pad()), SR, OPTS);
    expect(a.runs).toHaveLength(0);
    expect(a.style.agility).toBe(0);
  });

  it('a long note with +/-60 cent vibrato at 6.5 Hz has no run', () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 3, f0: 196, vibrato: { rateHz: 6.5, extentCents: 60 } });
    const a = analyzeTake(concat(pad(), x, pad()), SR, OPTS);
    expect(a.runs).toHaveLength(0);
    expect(a.notes).toHaveLength(1);
  });

  it('slow, wide vibrato (4.5 Hz, +/-120 cents) is one note, not a run', () => {
    const x = synthVoice({ sampleRate: SR, durationSec: 2.5, f0: 196, vibrato: { rateHz: 4.5, extentCents: 120 } });
    const a = analyzeTake(concat(pad(), x, pad()), SR, OPTS);
    expect(a.runs).toHaveLength(0);
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0].vibrato?.rateHz).toBeCloseTo(4.5, 0);
  });

  it('agility is the median run speed', () => {
    const run = (dur: number) => synthMelody([57, 59, 60, 62, 64, 62, 60].map((midi) => ({ midi, durSec: dur })), { sampleRate: SR });
    const held = synthMelody([{ midi: 57, durSec: 1.2 }], { sampleRate: SR });
    const x = concat(pad(), run(0.12), held, silence(0.5, SR), run(0.16), held, pad());
    const a = analyzeTake(x, SR, OPTS);
    expect(a.runs).toHaveLength(2);
    expect(a.style.agility).toBeGreaterThan(6);
    expect(a.style.agility).toBeLessThan(8.5);
  });
});
