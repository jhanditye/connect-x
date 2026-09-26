// Calibration of the voice-quality measures on the synthesiser. Prints the table that is copied
// into the doc comment at the top of spectral.ts (run: npx vitest run src/dsp/spectral.calibration.test.ts)
// and asserts the orderings the analysis engine relies on.

import { describe, expect, it } from 'vitest';
import { analyzeSpectralFrame, hnrFromPeriodicity } from './spectral';
import { trackPitch } from './pitch';
import { mix, synthVoice, whiteNoise, type SynthOptions, type Vowel } from '../testing/synth';

const SR = 22050;
const F0S = [147, 220, 330];
const VOWELS: Vowel[] = ['a', 'i'];

const VOICES: { name: string; opts: Partial<SynthOptions> }[] = [
  { name: 'pressed', opts: { tiltDbPerOct: -7 } },
  { name: 'modal', opts: { tiltDbPerOct: -12 } },
  { name: 'light mix', opts: { tiltDbPerOct: -14, h1BoostDb: 3, breathNoise: 0.15 } },
  { name: 'breathy', opts: { tiltDbPerOct: -16, h1BoostDb: 6, breathNoise: 0.6 } },
  { name: 'falsetto', opts: { tiltDbPerOct: -20, h1BoostDb: 10, breathNoise: 0.35 } },
  { name: 'whisper-ish', opts: { tiltDbPerOct: -16, breathNoise: 1.5 } },
  { name: 'rasp', opts: { tiltDbPerOct: -9, subharmonic: 0.4, jitter: 0.02, shimmer: 0.08 } },
];

const KEYS = ['voiced', 'periodicity', 'hnr', 'h1h2', 'tilt', 'alpha', 'centroid', 'cpp', 'sub'] as const;
type Row = Record<(typeof KEYS)[number], number>;

function median(xs: number[]): number {
  const s = xs.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/**
 * Medians over frames 0.1-0.7 s of a 0.8 s tone. Spectral measures use the true f0.
 * snrDb adds white "recording" noise at that level below the tone's RMS.
 */
function measure(opts: Partial<SynthOptions>, f0: number, vowel: Vowel, snrDb?: number): Row {
  let x = synthVoice({ ...opts, durationSec: 0.8, f0, vowel });
  if (snrDb !== undefined) {
    const rms = Math.sqrt(x.reduce((acc, v) => acc + v * v, 0) / x.length);
    x = mix(x, whiteNoise(0.8, rms * Math.pow(10, -snrDb / 20), SR, 11));
  }
  const tr = trackPitch(x, SR);
  const per: number[] = [];
  const perAll: number[] = [];
  let frames = 0;
  let voiced = 0;
  const cols: Record<string, number[]> = { h1h2: [], tilt: [], alpha: [], centroid: [], cpp: [], sub: [] };
  for (let i = 0; i < tr.times.length; i++) {
    const t = tr.times[i];
    if (t < 0.1 || t > 0.7) continue;
    frames++;
    perAll.push(tr.periodicity[i]);
    if (tr.voiced[i]) {
      voiced++;
      per.push(tr.periodicity[i]);
    }
    const s = analyzeSpectralFrame(x, SR, Math.round(t * SR), f0);
    cols.h1h2.push(s.h1h2Db);
    cols.tilt.push(s.tiltDbPerOct);
    cols.alpha.push(s.alphaRatioDb);
    cols.centroid.push(s.centroidHz);
    cols.cpp.push(s.cppDb);
    cols.sub.push(s.subharmonicDb);
  }
  // Periodicity as the analysis engine sees it (voiced frames); all frames when nothing is voiced.
  const periodicity = median(per.length >= 5 ? per : perAll);
  return {
    voiced: voiced / frames,
    periodicity,
    hnr: hnrFromPeriodicity(periodicity),
    h1h2: median(cols.h1h2),
    tilt: median(cols.tilt),
    alpha: median(cols.alpha),
    centroid: median(cols.centroid),
    cpp: median(cols.cpp),
    sub: median(cols.sub),
  };
}

const fmt = (v: number, d = 1) => (Number.isNaN(v) ? 'NaN' : v.toFixed(d));

function formatRow(label: string, r: Row): string {
  return [
    label.padEnd(22),
    `${fmt(100 * r.voiced, 0)}%`.padStart(5),
    fmt(r.periodicity, 2).padStart(5),
    fmt(r.hnr).padStart(5),
    fmt(r.h1h2).padStart(6),
    fmt(r.tilt).padStart(6),
    fmt(r.alpha).padStart(6),
    fmt(r.centroid, 0).padStart(6),
    fmt(r.cpp).padStart(5),
    fmt(r.sub).padStart(6),
  ].join(' ');
}

const HEADER = `${'voice / f0 / vowel'.padEnd(22)} voic%  per.   HNR  H1-H2   tilt  alpha  centr   CPP   subh`;

describe('spectral calibration on the synthesiser', () => {
  it('prints the calibration table and keeps the expected orderings', () => {
    const summary = new Map<string, Row>();
    const lines: string[] = [HEADER];
    for (const v of VOICES) {
      const rows: Row[] = [];
      for (const f0 of F0S) {
        for (const vowel of VOWELS) {
          const r = measure(v.opts, f0, vowel);
          rows.push(r);
          lines.push(formatRow(`${v.name} ${f0} ${vowel}`, r));
        }
      }
      const agg = Object.fromEntries(KEYS.map((k) => [k, median(rows.map((r) => r[k]))])) as Row;
      summary.set(v.name, agg);
    }
    lines.push('', 'Medians over f0 147/220/330 Hz x vowels a/i:', HEADER);
    for (const [name, agg] of summary) lines.push(formatRow(name, agg));
    lines.push('', 'Recording noise (white, SNR re tone RMS), 220 Hz vowel a:', HEADER);
    const noisy: Row[] = [];
    for (const [name, opts] of [
      ['modal', VOICES[1].opts],
      ['breathy', VOICES[3].opts],
    ] as const) {
      for (const snr of [40, 30, 20]) {
        const r = measure(opts, 220, 'a', snr);
        noisy.push(r);
        lines.push(formatRow(`${name} SNR ${snr} dB`, r));
      }
    }
    console.log(lines.join('\n'));
    // Recording noise lowers CPP but a modal voice at 30 dB SNR stays clearer than a breathy one.
    expect(noisy[1].cpp).toBeGreaterThan(noisy[4].cpp);

    const s = (name: string) => summary.get(name)!;
    // Clarity: pressed/modal > light mix > breathy/falsetto > whisper.
    expect(s('pressed').cpp).toBeGreaterThan(s('light mix').cpp);
    expect(s('modal').cpp).toBeGreaterThan(s('light mix').cpp);
    expect(s('light mix').cpp).toBeGreaterThan(s('breathy').cpp);
    expect(s('breathy').cpp).toBeGreaterThan(s('whisper-ish').cpp);
    expect(s('pressed').periodicity).toBeGreaterThan(s('breathy').periodicity);
    expect(s('breathy').periodicity).toBeGreaterThan(s('whisper-ish').periodicity);
    // H1-H2 rises from pressed through modal and mix to breathy and falsetto.
    expect(s('modal').h1h2).toBeGreaterThan(s('pressed').h1h2);
    expect(s('light mix').h1h2).toBeGreaterThan(s('modal').h1h2);
    expect(s('breathy').h1h2).toBeGreaterThan(s('light mix').h1h2);
    expect(s('falsetto').h1h2).toBeGreaterThan(s('light mix').h1h2);
    // Rasp stands out on the subharmonic measure.
    expect(s('rasp').sub).toBeGreaterThan(s('modal').sub + 20);
    expect(s('rasp').sub).toBeGreaterThan(s('breathy').sub + 5);
    // Voicing: whisper-ish is mostly unvoiced, the rest mostly voiced.
    expect(s('whisper-ish').voiced).toBeLessThan(0.5);
    for (const name of ['pressed', 'modal', 'light mix', 'breathy', 'falsetto', 'rasp']) expect(s(name).voiced).toBeGreaterThan(0.85);
  });
});
