import { describe, expect, it } from 'vitest';
import {
  MIX_CONFIDENCE_HIGH,
  MIX_CONFIDENCE_POOR,
  MIX_CONFIDENCE_WARN,
  mixConfidenceBand,
  mixReport,
  mixTrustBand,
  suggestsFullSong,
  WARN_MIN_VOICED_SEC,
} from './quality';

describe('mixConfidenceBand', () => {
  it('splits at 0.70, 0.80 and 0.88 (the evaluation bands) and counts anything not a number as poor', () => {
    expect(mixConfidenceBand(1)).toBe('high');
    expect(mixConfidenceBand(MIX_CONFIDENCE_HIGH)).toBe('high');
    expect(mixConfidenceBand(0.87)).toBe('ok');
    expect(mixConfidenceBand(MIX_CONFIDENCE_WARN)).toBe('ok');
    expect(mixConfidenceBand(0.79)).toBe('low');
    expect(mixConfidenceBand(MIX_CONFIDENCE_POOR)).toBe('low');
    expect(mixConfidenceBand(0.69)).toBe('poor');
    expect(mixConfidenceBand(0)).toBe('poor');
    expect(mixConfidenceBand(NaN)).toBe('poor');
    expect(mixConfidenceBand(-3)).toBe('poor');
  });
});

describe('mixReport', () => {
  it('says nothing when the lead vocal was followed well', () => {
    expect(mixReport({ confidence: 0.9, voicedSec: 40 })).toEqual({ warnings: [], issues: [] });
    expect(mixReport({ confidence: MIX_CONFIDENCE_WARN, voicedSec: 40 })).toEqual({ warnings: [], issues: [] });
  });

  it('warns below 0.8 and says more below 0.7, naming a way out each time', () => {
    const low = mixReport({ confidence: 0.75, voicedSec: 40 });
    expect(low.issues).toEqual([]);
    expect(low.warnings).toHaveLength(1);
    expect(low.warnings[0]).toMatch(/hard to follow/);
    expect(low.warnings[0]).toMatch(/vocal-only file/);
    const poor = mixReport({ confidence: 0.5, voicedSec: 40 });
    expect(poor.warnings[0]).toMatch(/very hard to follow/);
    expect(poor.warnings[0]).toMatch(/vocal stem/);
    expect(poor.warnings[0]).not.toBe(low.warnings[0]);
  });

  it('flags too little singing (and only that) under 3 s, with the amount found', () => {
    const none = mixReport({ confidence: 0, voicedSec: 0 });
    expect(none.issues).toEqual(['too-little-singing']);
    expect(none.warnings).toHaveLength(1);
    expect(none.warnings[0]).toMatch(/^No lead vocal could be followed/);
    const some = mixReport({ confidence: 0.9, voicedSec: 1.26 });
    expect(some.issues).toEqual(['too-little-singing']);
    expect(some.warnings[0]).toMatch(/^Only 1\.3 s of lead vocal/);
    expect(mixReport({ confidence: 0.9, voicedSec: WARN_MIN_VOICED_SEC }).issues).toEqual([]);
    expect(mixReport({ confidence: 0.9, voicedSec: NaN }).issues).toEqual(['too-little-singing']);
    for (const r of [none, some, mixReport({ confidence: NaN, voicedSec: 10 })]) for (const w of r.warnings) expect(w).not.toMatch(/NaN|undefined/);
  });
});

describe('suggestsFullSong', () => {
  it('is true for a solo analysis that raised the accompaniment issue, and nothing else', () => {
    expect(suggestsFullSong({ issues: ['accompaniment', 'noisy'] })).toBe(true);
    expect(suggestsFullSong({ mode: 'solo', issues: ['accompaniment'] })).toBe(true);
    expect(suggestsFullSong({ issues: ['noisy', 'clipping', 'too-little-singing', 'speech-like'] })).toBe(false);
    expect(suggestsFullSong({ issues: [] })).toBe(false);
  });

  it('is false for an analysis that is already a mix analysis, and tolerates a missing issues list', () => {
    expect(suggestsFullSong({ mode: 'mix', issues: ['accompaniment'] })).toBe(false);
    expect(suggestsFullSong({} as { issues: [] })).toBe(false);
  });
});

describe('mixTrustBand and the purity warning', () => {
  it('is the confidence band when there is no purity, or the line is mostly the voice', () => {
    expect(mixTrustBand({ confidence: 0.92 })).toBe('high');
    expect(mixTrustBand({ confidence: 0.84, purity: 0.9 })).toBe('ok');
    expect(mixTrustBand({ confidence: 0.92, purity: NaN })).toBe('high');
  });

  it('never calls a rough guide better than low, even when the confidence is high (a bass line scores like a voice)', () => {
    expect(mixTrustBand({ confidence: 0.92, purity: 0.65 })).toBe('low');
    expect(mixTrustBand({ confidence: 0.84, purity: 0.6 })).toBe('low');
    expect(mixTrustBand({ confidence: 0.92, purity: 0.45 })).toBe('poor');
    expect(mixTrustBand({ confidence: 0.6, purity: 0.65 })).toBe('poor');
  });

  it('warns when the confidence is fine but the line is partly the band, with the share and a way out', () => {
    const r = mixReport({ confidence: 0.9, voicedSec: 40, purity: 0.58 });
    expect(r.issues).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/58%/);
    expect(r.warnings[0]).toMatch(/rough guide/);
    expect(r.warnings[0]).toMatch(/vocal-only file/);
    expect(mixReport({ confidence: 0.9, voicedSec: 40, purity: 0.85 }).warnings).toEqual([]);
    expect(mixReport({ confidence: 0.9, voicedSec: 40 }).warnings).toEqual([]);
  });

  it('does not stack a second warning on one the confidence already gave', () => {
    expect(mixReport({ confidence: 0.75, voicedSec: 40, purity: 0.5 }).warnings).toHaveLength(1);
    expect(mixReport({ confidence: 0.5, voicedSec: 40, purity: 0.5 }).warnings).toHaveLength(1);
  });
});
