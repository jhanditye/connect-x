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

describe('runs on synthesised takes', () => {
  it('8 notes of 0.12 s make one run at ~8 notes/s', () => {
    const notes = [60, 62, 64, 65, 67, 65, 64, 62].map((midi) => ({ midi, durSec: 0.12 }));
    const a = analyzeTake(concat(pad(), synthMelody(notes, { sampleRate: SR }), pad()), SR, OPTS);
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0].noteCount).toBeGreaterThanOrEqual(7);
    expect(a.runs[0].notesPerSec).toBeGreaterThan(7);
    expect(a.runs[0].notesPerSec).toBeLessThan(9.5);
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
