import { describe, expect, it } from 'vitest';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { VoiceAnalysis } from '../types';
import { referenceUsability } from './reference';

const solo = (patch: Partial<VoiceAnalysis> = {}): VoiceAnalysis => ({ ...makeFakeAnalysis(), ...patch });
const mix = (patch: Partial<VoiceAnalysis> = {}): VoiceAnalysis => ({ ...makeFakeAnalysis(), mode: 'mix', issues: ['accompaniment'], voicedSec: 40, ...patch });

describe('referenceUsability: purpose', () => {
  it('defaults to targets: a clean solo clip is usable, exactly as before', () => {
    expect(referenceUsability(solo())).toEqual({ usable: true, reason: null });
    expect(referenceUsability(solo(), 'targets')).toEqual({ usable: true, reason: null });
    expect(referenceUsability(solo(), 'comparison')).toEqual({ usable: true, reason: null });
  });

  it('a mix-mode analysis never gives targets, and says why and what is still possible', () => {
    for (const purpose of [undefined, 'targets'] as const) {
      const r = referenceUsability(mix(), purpose);
      expect(r.usable).toBe(false);
      expect(r.reason).toMatch(/analysed as a full song/);
      expect(r.reason).toMatch(/vocal stem/);
      expect(r.reason).toMatch(/phrase-by-phrase practice/);
    }
    // also when the issue list was lost somewhere along the way (the mode alone is enough)
    expect(referenceUsability(mix({ issues: [] })).usable).toBe(false);
  });

  it('a mix-mode analysis is usable for phrase comparison', () => {
    expect(referenceUsability(mix(), 'comparison')).toEqual({ usable: true, reason: null });
    expect(referenceUsability(mix({ issues: ['accompaniment', 'trimmed'] }), 'comparison').usable).toBe(true);
  });

  it('a solo analysis that still says accompaniment is unusable for both, and for comparison the fix is the full-song mode', () => {
    const song = solo({ issues: ['accompaniment'] });
    const asTarget = referenceUsability(song, 'targets');
    expect(asTarget.usable).toBe(false);
    expect(asTarget.reason).toMatch(/full song mix/);
    expect(asTarget.reason).toMatch(/a cappella section/);
    const asComparison = referenceUsability(song, 'comparison');
    expect(asComparison.usable).toBe(false);
    expect(asComparison.reason).toMatch(/Analyse it as a full song/);
  });

  it('a mix with too little lead vocal is unusable and names the fix without mentioning targets', () => {
    for (const bad of [mix({ voicedSec: 1.2, issues: ['accompaniment', 'too-little-singing'] }), mix({ voicedSec: 2.4 }), mix({ voicedSec: 0, issues: ['accompaniment', 'too-little-singing'] })]) {
      const r = referenceUsability(bad, 'comparison');
      expect(r.usable).toBe(false);
      expect(r.reason).toMatch(/lead vocal/);
      expect(r.reason).toMatch(/continuous singing|isolated vocal/);
      expect(r.reason).not.toMatch(/build targets/);
      expect(r.reason).not.toMatch(/NaN|undefined/);
    }
    expect(referenceUsability(mix({ voicedSec: 3 }), 'comparison').usable).toBe(true);
    expect(referenceUsability(mix({ voicedSec: NaN }), 'comparison').usable).toBe(false);
  });

  it('comparison needs 3 s of singing where targets need 5 s', () => {
    const short = solo({ voicedSec: 4 });
    expect(referenceUsability(short, 'targets').usable).toBe(false);
    expect(referenceUsability(short, 'comparison').usable).toBe(true);
    expect(referenceUsability(solo({ voicedSec: 2.5 }), 'comparison').usable).toBe(false);
    expect(referenceUsability(solo({ issues: ['too-little-singing'] }), 'comparison').usable).toBe(false);
  });

  it('speech-like clips stay unusable for both purposes', () => {
    for (const purpose of ['targets', 'comparison'] as const) expect(referenceUsability(solo({ issues: ['speech-like'] }), purpose).usable).toBe(false);
  });
});
