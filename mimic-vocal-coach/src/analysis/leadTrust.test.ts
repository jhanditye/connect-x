import { describe, expect, it } from 'vitest';
import type { FrameFeatures, NoteSegment } from '../types';
import { makeSongStems, mixSong } from '../testing/songMix';
import { analyzeTake } from './analyze';
import { leadExtractionOf, type MixAnalysis } from './mixMode';
import { noteTrust, purityOf, ROUGH_GUIDE_PURITY } from './leadTrust';

const HOP = 0.01;

function note(start: number, end: number, midi: number): NoteSegment {
  return { start, end, midi, nearestMidi: Math.round(midi), centsOff: 0, vibrato: null, register: null, meanRmsDb: -30 };
}

/** n voiced frames; only `voiced` is read by noteTrust. */
function frames(n: number): FrameFeatures[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * HOP, voiced: true }) as FrameFeatures);
}

function trust(notes: NoteSegment[], opts: { conf?: number; rel?: number; share?: number } = {}) {
  const n = Math.round(notes[notes.length - 1].end / HOP) + 5;
  return noteTrust({
    notes,
    frames: frames(n),
    confidence: new Float64Array(n).fill(opts.conf ?? 0.9),
    relLevelDb: new Float64Array(n).fill(opts.rel ?? -5),
    clipShare: opts.share ?? 0.35,
    hopSec: HOP,
  });
}

describe('noteTrust', () => {
  it('gives one probability per note, in 0..1, in the order of the notes', () => {
    const t = trust([note(0, 0.6, 60), note(0.6, 1.2, 62), note(3, 3.2, 40)]);
    expect(t).toHaveLength(3);
    for (const p of t) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('trusts a long note in a stepwise line over a short note that jumps an octave from its neighbours', () => {
    const line = trust([note(0, 0.5, 60), note(0.5, 1.0, 62), note(1.0, 1.5, 64)]);
    const jump = trust([note(0, 0.5, 60), note(0.5, 0.62, 48), note(0.62, 1.2, 60)]);
    expect(line[1]).toBeGreaterThan(0.6);
    expect(jump[1]).toBeLessThan(0.3);
    expect(line[1]).toBeGreaterThan(jump[1] + 0.3);
  });

  it('is lower for a note that is quieter and less confident, and for a clip the extractor explains less of', () => {
    const notes = [note(0, 0.5, 60), note(0.5, 1.0, 62)];
    const base = trust(notes)[0];
    expect(trust(notes, { rel: -15 })[0]).toBeLessThan(base);
    expect(trust(notes, { share: 0.2 })[0]).toBeLessThan(base);
    expect(trust(notes, { conf: 0.7 })[0]).not.toBeCloseTo(base, 2); // the weight of the confidence is small once the other cues are known
  });

  it('handles no notes, and a note with no voiced frame, without throwing', () => {
    expect(noteTrust({ notes: [], frames: [], confidence: [], relLevelDb: [], clipShare: 0.3, hopSec: HOP })).toEqual([]);
    const t = noteTrust({ notes: [note(0, 0.5, 60)], frames: frames(0), confidence: [], relLevelDb: [], clipShare: 0.3, hopSec: HOP });
    expect(t).toHaveLength(1);
    expect(Number.isFinite(t[0])).toBe(true);
  });
});

describe('purityOf', () => {
  it('weights each note by its length', () => {
    const notes = [note(0, 3, 60), note(3, 4, 40)];
    expect(purityOf(notes, [1, 0])).toBeCloseTo(0.75, 6);
    expect(purityOf(notes, [0.5, 0.5])).toBeCloseTo(0.5, 6);
    expect(purityOf([], [])).toBe(0);
  });
});

describe('note trust on proxy mixes (analyzeTake, mode mix)', () => {
  const stems = makeSongStems();
  const SR = 22050;
  const truthMidi = (t: number, m: ReturnType<typeof mixSong>): number => {
    const f = m.truthHz[Math.round(t / HOP)];
    return Number.isFinite(f) ? 12 * Math.log2(f / 440) + 69 : NaN;
  };

  it('carries one trust per note, a purity and the rough-guide flag, and leadExtractionOf hands them on', () => {
    const m = mixSong(stems, 3);
    const a = analyzeTake(m.mono, SR, { voiceType: 'tenor', mode: 'mix' }) as MixAnalysis;
    const le = a.leadExtraction;
    expect(le.noteTrust).toHaveLength(a.notes.length);
    expect(le.trustedNotes).toBeCloseTo(le.noteTrust!.reduce((x, y) => x + y, 0), 9);
    expect(le.purity).toBeCloseTo(purityOf(a.notes, le.noteTrust!), 9);
    expect(le.harmonicShare).toBeGreaterThan(0.2);
    expect(leadExtractionOf(a)?.noteTrust).toEqual(le.noteTrust);
    // an analysis whose trust array does not line up with its notes (an older or edited record) hands on none of the new fields
    const broken = { ...a, leadExtraction: { ...le, noteTrust: le.noteTrust!.slice(1) } };
    const old = leadExtractionOf(broken as MixAnalysis)!;
    expect(old.confidence).toBe(le.confidence);
    expect(old.noteTrust).toBeUndefined();
    expect(old.purity).toBeUndefined();
  });

  it('separates the notes that are the sung line from the others: sung notes score higher on average at every level', () => {
    for (const db of [3, 0, -3]) {
      const m = mixSong(stems, db);
      const a = analyzeTake(m.mono, SR, { voiceType: 'tenor', mode: 'mix' }) as MixAnalysis;
      const sung: number[] = [];
      const other: number[] = [];
      a.notes.forEach((n, i) => {
        const tm = truthMidi((n.start + n.end) / 2, m);
        (Number.isFinite(tm) && Math.abs(tm - n.midi) < 1 ? sung : other).push(a.leadExtraction.noteTrust![i]);
      });
      const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
      expect(sung.length, `${db} dB`).toBeGreaterThanOrEqual(10);
      if (other.length >= 3) expect(mean(sung), `${db} dB: ${mean(sung).toFixed(2)} vs ${mean(other).toFixed(2)}`).toBeGreaterThan(mean(other) + 0.1);
    }
  }, 30000);

  it('calls the extraction a rough guide with the voice under the band and a good one with the voice over it', () => {
    const over = analyzeTake(mixSong(stems, 6).mono, SR, { voiceType: 'tenor', mode: 'mix' }) as MixAnalysis;
    const under = analyzeTake(mixSong(stems, -6).mono, SR, { voiceType: 'tenor', mode: 'mix' }) as MixAnalysis;
    expect(over.leadExtraction.roughGuide).toBe(false);
    expect(over.leadExtraction.purity!).toBeGreaterThan(ROUGH_GUIDE_PURITY);
    expect(under.leadExtraction.roughGuide).toBe(true);
    expect(under.leadExtraction.purity!).toBeLessThan(ROUGH_GUIDE_PURITY);
    expect(over.leadExtraction.purity!).toBeGreaterThan(under.leadExtraction.purity! + 0.15);
  }, 30000);
});
