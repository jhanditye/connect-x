import { describe, expect, it } from 'vitest';
import { trackPitch } from '../dsp/pitch';
import { BASE_BLOCK_SEC, makeSongStems, mixSong, rawPitchAccuracy, voicingFalseAlarm } from './songMix';

const SR = 22050;
const HOP = 0.01;

/** RMS (dB) of x over the samples around the truth-voiced frames. */
function sungRmsDb(x: Float32Array, truthHz: Float64Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < truthHz.length; i++) {
    if (!Number.isFinite(truthHz[i])) continue;
    const c = Math.round(i * HOP * SR);
    for (let k = Math.max(0, c - 110); k < Math.min(x.length, c + 110); k++) {
      sum += x[k] * x[k];
      n++;
    }
  }
  return 10 * Math.log10(sum / n);
}

describe('makeSongStems / mixSong (proxy mixes for the full-song tests)', () => {
  const stems = makeSongStems();

  it('builds one 16 s block of each stem and a ground truth on the 10 ms grid', () => {
    expect(stems.sampleRate).toBe(SR);
    expect(stems.vocal.length).toBe(Math.round(BASE_BLOCK_SEC * SR));
    expect(stems.bandL.length).toBe(stems.vocal.length);
    expect(stems.bandR.length).toBe(stems.vocal.length);
    expect(stems.truthHz.length).toBe(Math.floor((stems.vocal.length - 1) / (HOP * SR)) + 1);
    const voiced = stems.truthHz.filter((v) => Number.isFinite(v)).length;
    expect(voiced).toBeGreaterThan(1000);
    expect(voiced).toBeLessThan(1400);
    for (const v of stems.truthHz) if (Number.isFinite(v)) expect(v).toBeGreaterThan(180);
  });

  it('the ground truth matches the clean vocal: the plain tracker agrees with it', () => {
    expect(rawPitchAccuracy(trackPitch(stems.vocal, SR).f0, stems.truthHz)).toBeGreaterThan(0.95);
  });

  it('sets the vocal-to-band level exactly, whatever the request', () => {
    for (const db of [6, 3, 0, -6, -12]) {
      const m = mixSong(stems, db);
      const bandOnly = Float32Array.from(m.mono, (v, i) => v - m.vocal[i]);
      expect(sungRmsDb(m.vocal, m.truthHz) - sungRmsDb(bandOnly, m.truthHz)).toBeCloseTo(db, 1);
      expect(m.vocalToBandDb).toBe(db);
    }
  });

  it('tiles the block to any length and the truth with it; mono is the mean of the channels', () => {
    const m = mixSong(stems, 0, { seconds: 40 });
    expect(m.left.length).toBe(40 * SR);
    expect(m.right.length).toBe(40 * SR);
    expect(m.truthHz.length).toBe(Math.floor((40 * SR - 1) / (HOP * SR)) + 1);
    const period = Math.round(BASE_BLOCK_SEC / HOP);
    for (const i of [60, 300, 1000]) expect(m.truthHz[i + period]).toBe(m.truthHz[i]);
    for (const i of [0, 12345, 400000]) expect(m.mono[i]).toBeCloseTo(0.5 * (m.left[i] + m.right[i]), 6);
    expect(m.left.subarray(0, 1000)).not.toEqual(m.right.subarray(0, 1000));
  });

  it('dual mono has identical channels, and the band stays decorrelated otherwise', () => {
    const dual = mixSong(stems, 0, { stereo: false });
    expect(dual.right).toBe(dual.left);
    expect(dual.mono).toBe(dual.left);
    const st = mixSong(stems, 0);
    expect(st.right).not.toBe(st.left);
  });

  it('marks the band-only stretches (150 ms clear of any singing) and tiles them with the truth', () => {
    expect(stems.rest.length).toBe(stems.truthHz.length);
    const rest = stems.rest.reduce((a, b) => a + b, 0);
    expect(rest).toBeGreaterThan(150);
    expect(rest).toBeLessThan(400);
    for (let i = 0; i < stems.rest.length; i++) if (stems.rest[i]) expect(Number.isFinite(stems.truthHz[i])).toBe(false);
    expect(stems.rest[0]).toBe(1); // the lead-in before the first line
    expect(stems.rest[400]).toBe(0); // inside the first line
    const m = mixSong(stems, 0, { seconds: 40 });
    expect(m.rest.length).toBe(m.truthHz.length);
    expect(m.rest[500 + Math.round(BASE_BLOCK_SEC / HOP)]).toBe(stems.rest[500]);
  });

  it('is deterministic and caches the stems; a different seed gives a different band', () => {
    expect(makeSongStems()).toBe(stems);
    const again = mixSong(stems, 0);
    expect(again.mono).toEqual(mixSong(stems, 0).mono);
    expect(makeSongStems({ seed: 4 }).bandL).not.toEqual(stems.bandL);
    expect(makeSongStems({ transpose: 5 }).bandL).toBe(stems.bandL); // the band does not depend on the vocal transposition
  });

  it('transposing moves the truth by the same number of semitones', () => {
    const up = makeSongStems({ transpose: 7 });
    for (let i = 0; i < stems.truthHz.length; i++) {
      if (!Number.isFinite(stems.truthHz[i])) continue;
      expect(12 * Math.log2(up.truthHz[i] / stems.truthHz[i])).toBeCloseTo(7, 6);
    }
  });
});

describe('band types', () => {
  const builtin = makeSongStems();

  it('the default band is the built-in one, whatever else is asked', () => {
    expect(makeSongStems({ band: 'builtin' })).toBe(builtin);
    expect(makeSongStems({ transpose: 7, band: 'builtin' }).bandL).toBe(builtin.bandL);
  });

  it('every band type keeps the vocal and the ground truth of its transposition and sets the level exactly', () => {
    for (const band of ['walking-bass', 'harmony', 'band-harmony'] as const) {
      const st = makeSongStems({ band });
      expect(st.vocal).toEqual(builtin.vocal);
      expect(st.truthHz).toEqual(builtin.truthHz);
      expect(st.bandL.length).toBe(builtin.bandL.length);
      for (const db of [3, -6]) {
        const m = mixSong(st, db);
        const bandOnly = Float32Array.from(m.mono, (v, i) => v - m.vocal[i]);
        expect(sungRmsDb(m.vocal, m.truthHz) - sungRmsDb(bandOnly, m.truthHz), `${band} ${db} dB`).toBeCloseTo(db, 1);
      }
    }
  });

  it('walking-bass is a centred moving bass line only: dual mono, nothing above 1.5 kHz, a new pitch every half second', () => {
    const st = makeSongStems({ band: 'walking-bass' });
    expect(st.bandR).toBe(st.bandL);
    let high = 0;
    let all = 0;
    const win = 1024;
    // crude spectral check: a zero-crossing rate low enough for a bass note (a 150 Hz tone crosses 300 times a second)
    for (let a = 0; a + win < st.bandL.length; a += win) {
      let cross = 0;
      for (let i = a + 1; i < a + win; i++) if (st.bandL[i - 1] < 0 !== st.bandL[i] < 0) cross++;
      all++;
      if (cross > win * (1500 / (SR / 2)) * 0.5) high++;
    }
    expect(high / all).toBeLessThan(0.02);
    const first = trackPitch(st.bandL.subarray(0, Math.round(1.5 * SR)), SR).f0;
    const hz = Array.from(first).filter((f) => f > 0);
    expect(Math.max(...hz) / Math.min(...hz)).toBeGreaterThan(1.3); // it moves
  });

  it('harmony follows the lead: the same rhythm, other pitches, a band that moves with the transposition', () => {
    const a = makeSongStems({ band: 'harmony' });
    const b = makeSongStems({ band: 'harmony', transpose: 5 });
    expect(a.bandL).not.toEqual(b.bandL);
    // silent exactly where the lead is silent (the lead-in before the first line)
    let lead = 0;
    for (let i = 0; i < Math.round(0.3 * SR); i++) lead += a.bandL[i] * a.bandL[i];
    expect(lead).toBe(0);
    // and not the lead itself
    expect(a.bandL).not.toEqual(a.vocal);
  });

  it('band-harmony is the built-in band with the backing voices on top', () => {
    const bh = makeSongStems({ band: 'band-harmony' });
    expect(bh.bandL).not.toEqual(builtin.bandL);
    expect(bh.bandL.length).toBe(builtin.bandL.length);
  });
});

describe('rawPitchAccuracy', () => {
  const truth = Float64Array.from([NaN, 220, 220, 440, NaN, 330]);

  it('counts only the frames that have a truth, within the tolerance', () => {
    expect(rawPitchAccuracy(Float64Array.from([100, 220, 220, 440, 100, 330]), truth)).toBe(1);
    expect(rawPitchAccuracy(Float64Array.from([NaN, 220 * 1.02, 220 * 1.04, 440, NaN, 330]), truth)).toBe(0.75); // +34 ok, +68 cents not
    expect(rawPitchAccuracy(Float64Array.from([NaN, 220 * 1.04, 220, 440, NaN, 330]), truth, 100)).toBe(1);
  });

  it('treats NaN, zero and an octave error as wrong, and ignores the frames beyond a shorter estimate', () => {
    expect(rawPitchAccuracy(Float64Array.from([0, NaN, 0, 880, 0, 165]), truth)).toBe(0);
    expect(rawPitchAccuracy(Float64Array.from([NaN, 220]), truth)).toBe(1);
    expect(rawPitchAccuracy(Float64Array.from([NaN, 220, 110]), truth)).toBe(0.5);
    expect(rawPitchAccuracy([], truth)).toBe(0);
    expect(rawPitchAccuracy([1, 2, 3], Float64Array.from([NaN, NaN]))).toBe(0);
  });
});

describe('voicingFalseAlarm', () => {
  const rest = Uint8Array.from([1, 1, 0, 1, 0, 1]);

  it('is the share of rest frames reported voiced', () => {
    expect(voicingFalseAlarm(Float64Array.from([NaN, NaN, 220, NaN, 220, NaN]), rest)).toBe(0);
    expect(voicingFalseAlarm(Float64Array.from([220, NaN, 0, 220, NaN, NaN]), rest)).toBe(0.5);
    expect(voicingFalseAlarm(Float64Array.from([220, 220, 220, 220, 220, 220]), rest)).toBe(1);
  });

  it('ignores frames beyond the shorter array and is 0 without rest frames', () => {
    expect(voicingFalseAlarm(Float64Array.from([220, NaN]), rest)).toBe(0.5);
    expect(voicingFalseAlarm([], rest)).toBe(0);
    expect(voicingFalseAlarm(Float64Array.from([220, 220]), new Uint8Array(2))).toBe(0);
  });
});
