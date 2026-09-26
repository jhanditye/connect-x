import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis, makeFakeComparison, makeFakePlan, makeFakeProfile, makeFakeReferenceComparison } from '../../testing/fixtures';
import { buildAnalysisExport, slugify, toJson } from './download';
import { looksLikeAudio } from './FileDrop';
import { formatCents, formatClock, formatDuration, formatTranspose, noteName, noteRange, parseA4, percent, signed, tunerReading } from './format';
import { blockLevel, levelState, meterFraction, traceWindow } from './live';
import { registerTarget, userUpperShares } from './registers';
import { parseBlocks } from './RichText';
import { possessive, shortName, singerColor } from './singer';
import { styleDiffText } from './styleDiff';

describe('format', () => {
  it('formats clocks and durations', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatDuration(12.34)).toBe('12.3 s');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(NaN)).toBe('–');
  });

  it('formats signed cents with a true minus sign', () => {
    expect(formatCents(12.4)).toBe('+12¢');
    expect(formatCents(-7.6)).toBe('−8¢');
    expect(formatCents(0.2)).toBe('0¢');
    expect(formatCents(NaN)).toBe('–');
  });

  it('describes transpositions', () => {
    expect(formatTranspose(0)).toBe('Original key');
    expect(formatTranspose(-2)).toBe('2 semitones down');
    expect(formatTranspose(1)).toBe('1 semitone up');
  });

  it('names notes and ranges, tolerating nulls', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(null)).toBe('–');
    expect(noteRange(55, 69)).toBe('G3–A4');
    expect(noteRange(null, 69)).toBe('–');
    expect(percent(0.426)).toBe('43%');
    expect(percent(null)).toBe('–');
    expect(signed(0.2)).toBe('+0.20');
    expect(signed(-1.26, 1)).toBe('−1.3');
    expect(signed(-0.001)).toBe('0.00');
  });

  it('reads the tuner: nearest note and cents offset, honouring A4', () => {
    const a = tunerReading(440);
    expect(a?.name).toBe('A4');
    expect(a?.cents).toBeCloseTo(0, 6);
    const sharp = tunerReading(440 * Math.pow(2, 20 / 1200));
    expect(sharp?.cents).toBeCloseTo(20, 4);
    expect(tunerReading(442, 442)?.cents).toBeCloseTo(0, 6);
    const flatC = tunerReading(261.63 * Math.pow(2, -30 / 1200));
    expect(flatC?.name).toBe('C4');
    expect(flatC?.cents).toBeCloseTo(-30, 0);
    expect(tunerReading(0)).toBeNull();
  });

  it('parses A4 tuning within a semitone of 440', () => {
    expect(parseA4('440')).toBe(440);
    expect(parseA4(' 442,5 ')).toBe(442.5);
    expect(parseA4('432')).toBe(432);
    expect(parseA4('500')).toBeNull();
    expect(parseA4('abc')).toBeNull();
    expect(parseA4('')).toBeNull();
  });
});

describe('live monitor helpers', () => {
  it('measures a full-scale sine at about -3 dBFS', () => {
    const n = 4800;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const { rmsDb, peak } = blockLevel(buf);
    expect(rmsDb).toBeCloseTo(-3.01, 1);
    expect(peak).toBeCloseTo(1, 2);
    expect(blockLevel(new Float32Array(10)).rmsDb).toBe(-120);
  });

  it('classifies levels', () => {
    expect(levelState(-80, 0.001)).toBe('silent');
    expect(levelState(-50, 0.01)).toBe('quiet');
    expect(levelState(-20, 0.3)).toBe('good');
    expect(levelState(-10, 0.95)).toBe('hot');
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(-30)).toBe(0.5);
    expect(meterFraction(6)).toBe(1);
  });

  it('centres the trace window on the median voiced pitch', () => {
    expect(traceWindow([NaN, 60, 62, 64, NaN])).toEqual({ lo: 53, hi: 71 });
    expect(traceWindow([], 64.5)).toEqual({ lo: 56, hi: 74 });
  });
});

describe('registers', () => {
  it('builds a normalised target from the profile, filling a missing share with the remainder', () => {
    const full = registerTarget(
      makeFakeProfile({
        targets: {
          chestInUpperRange: { ideal: 0.2, low: 0.1, high: 0.3, tolerance: 0.3, weight: 1 },
          mixInUpperRange: { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.3, weight: 1 },
          headInUpperRange: { ideal: 0.3, low: 0.2, high: 0.4, tolerance: 0.3, weight: 1 },
        },
      }),
    );
    expect(full).toEqual({ chest: 0.2, mix: 0.5, head: 0.3 });
    const two = registerTarget(
      makeFakeProfile({
        targets: {
          mixInUpperRange: { ideal: 0.6, low: 0.4, high: 0.7, tolerance: 0.3, weight: 1 },
          headInUpperRange: { ideal: 0.3, low: 0.2, high: 0.4, tolerance: 0.3, weight: 1 },
        },
      }),
    );
    expect(two?.chest).toBeCloseTo(0.1, 6);
    expect(two!.chest + two!.mix + two!.head).toBeCloseTo(1, 6);
    // The fake profile only targets mix, so there is nothing to compare shares against.
    expect(registerTarget(makeFakeProfile())).toBeUndefined();
  });

  it('reads the user upper-range shares, or undefined when not measured', () => {
    expect(userUpperShares(makeFakeAnalysis())).toEqual({ chest: 0.55, mix: 0.3, head: 0.15 });
    expect(userUpperShares(makeFakeAnalysis({ mixInUpperRange: null }))).toBeUndefined();
  });
});

describe('RichText.parseBlocks', () => {
  it('splits paragraphs, headings and lists', () => {
    const blocks = parseBlocks('## Summary\nGood take.\nKeep going.\n\n- one\n- two\n  continued\n\n1. first\n2) second\n\nEnd');
    expect(blocks).toEqual([
      { kind: 'h', text: 'Summary' },
      { kind: 'p', text: 'Good take. Keep going.' },
      { kind: 'ul', items: ['one', 'two continued'] },
      { kind: 'ol', items: ['first', 'second'] },
      { kind: 'p', text: 'End' },
    ]);
  });
});

describe('downloads', () => {
  it('slugifies take names', () => {
    expect(slugify('My take (2)!')).toBe('my-take-2');
    expect(slugify('  ')).toBe('take');
    expect(slugify('Drill: Lip-trill siren')).toBe('drill-lip-trill-siren');
  });

  it('exports the analysis without frames but with the frame count', () => {
    const analysis = makeFakeAnalysis();
    const out = buildAnalysisExport(
      {
        takeName: 'Demo',
        source: 'demo',
        analysis,
        profile: makeFakeProfile(),
        comparison: makeFakeComparison(),
        plan: makeFakePlan(),
        referenceComparison: makeFakeReferenceComparison(),
        referenceName: 'ref',
      },
      new Date('2026-09-01T00:00:00Z'),
    ) as Record<string, Record<string, unknown>>;
    expect(out.analysis.frames).toBeUndefined();
    expect(out.analysis.frameCount).toBe(analysis.frames.length);
    expect(out.analysis.notes).toBeDefined();
    expect(out.profile.id).toBe('test-singer');
    expect(out.reference.name).toBe('ref');
    expect(out.exportedAt).toBe('2026-09-01T00:00:00.000Z');
    const json = toJson(out);
    expect(json).not.toContain('"frames"');
    expect(JSON.parse(json).comparison.overall).toBe(68);
  });

  it('rounds long floats in JSON and turns NaN into null', () => {
    expect(toJson({ a: 1 / 3, b: NaN, c: 2 })).toBe('{\n  "a": 0.3333,\n  "b": null,\n  "c": 2\n}');
  });
});

describe('upload filter and singer helpers', () => {
  it('accepts audio by type or extension', () => {
    expect(looksLikeAudio({ name: 'a.bin', type: 'audio/mpeg' })).toBe(true);
    expect(looksLikeAudio({ name: 'memo.m4a', type: '' })).toBe(true);
    expect(looksLikeAudio({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true);
    expect(looksLikeAudio({ name: 'notes.pdf', type: 'application/pdf' })).toBe(false);
  });

  it('maps builtin ids to theme-aware CSS variables', () => {
    expect(singerColor({ id: 'shawn-mendes', color: '#b97a12' })).toBe('var(--singer-shawn)');
    expect(singerColor({ id: 'daniel-caesar', color: '#3a7556' })).toBe('var(--singer-daniel)');
    expect(singerColor({ id: 'jalen-ngonda', color: '#b23c49' })).toBe('var(--singer-jalen)');
    expect(singerColor({ id: 'reference', color: '#b97a12' })).toBe('var(--singer-custom)');
    expect(singerColor({ id: 'other', color: '#123456' })).toBe('#123456');
    expect(singerColor(null)).toBe('var(--accent)');
    expect(shortName({ name: 'Daniel Caesar', source: 'builtin' })).toBe('Daniel');
    expect(shortName({ name: 'my clip', source: 'reference' })).toBe('my clip');
    expect(possessive('Jalen')).toBe('Jalen’s');
  });
});

describe('styleDiffText', () => {
  it('shows share differences in percentage points, not as fractions with a % sign', () => {
    expect(styleDiffText('vibratoPresence', -0.54)).toBe('−54 percentage points, toward straight');
    expect(styleDiffText('headInUpperRange', -0.71)).toBe('−71 percentage points, toward little falsetto');
    expect(styleDiffText('chestInUpperRange', 0.01)).toBe('+1 percentage point, toward chest-heavy');
  });

  it('says nothing about direction when the rounded difference is zero', () => {
    expect(styleDiffText('mixInUpperRange', 0.003)).toBe('0 percentage points');
    expect(styleDiffText('breathiness', 0.001)).toBe('0.00');
  });

  it('keeps physical units and 0..1 indices as they are', () => {
    expect(styleDiffText('breathiness', 0.12)).toBe('+0.12, toward airy');
    expect(styleDiffText('vibratoRateHz', -1.24)).toBe('−1.2 Hz, toward slow');
    expect(styleDiffText('dynamicRangeDb', 12.4)).toMatch(/^\+12 dB, toward /);
    expect(styleDiffText('breathiness', NaN)).toBe('–');
  });
});
