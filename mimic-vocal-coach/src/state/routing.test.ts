// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { SKILLS_VIEWS, type SkillsPath } from '../skills/types';
import { DEFAULT_ROUTE, goSkills, goTrainer, isMoreRoute, isRoute, MORE_ROUTES, parseRoute, parseSection, parseSkillsPath, parseTrainerPath, ROUTE_LABELS, ROUTES, routeHash, skillsHash, TAB_ROUTES, tabFor, TOP_ROUTES, trainerHash, type TrainerPath } from './routing';

describe('routing', () => {
  it('parses bare hash tokens', () => {
    for (const r of ROUTES) expect(parseRoute(`#${r}`)).toBe(r);
  });

  it('defaults to the trainer for empty or unknown hashes', () => {
    expect(DEFAULT_ROUTE).toBe('trainer');
    expect(parseRoute('')).toBe('trainer');
    expect(parseRoute('#')).toBe('trainer');
    expect(parseRoute(null)).toBe('trainer');
    expect(parseRoute(undefined)).toBe('trainer');
    expect(parseRoute('#nowhere')).toBe('trainer');
    expect(parseRoute('#main')).toBe('trainer');
  });

  it('keeps the old routes and adds trainer and more', () => {
    for (const r of ['studio', 'results', 'practice', 'progress', 'guide', 'settings', 'trainer', 'more'] as const) expect(ROUTES).toContain(r);
    expect(parseRoute('#more')).toBe('more');
  });

  it('parses trainer deep links to the trainer route', () => {
    expect(parseRoute('#trainer/c/abc/p/3')).toBe('trainer');
    expect(parseRoute('#/trainer/add')).toBe('trainer');
  });

  it('splits the routes between the phone tab bar, the desktop bar and More', () => {
    expect(TAB_ROUTES).toHaveLength(5);
    for (const r of [...TAB_ROUTES, ...TOP_ROUTES, ...MORE_ROUTES]) expect(ROUTES).toContain(r);
    // Every page is reachable on a phone: either a tab or listed under More.
    for (const r of ROUTES) expect([...TAB_ROUTES, ...MORE_ROUTES]).toContain(r);
    expect(TOP_ROUTES).not.toContain('more');
  });

  describe('parseTrainerPath', () => {
    it('reads the sub-views', () => {
      expect(parseTrainerPath('#trainer')).toEqual({ view: 'library' });
      expect(parseTrainerPath('#trainer/add')).toEqual({ view: 'add' });
      expect(parseTrainerPath('#trainer/c/clip-1')).toEqual({ view: 'clip', clipId: 'clip-1' });
      expect(parseTrainerPath('#trainer/c/clip-1/p/3')).toEqual({ view: 'phrase', clipId: 'clip-1', phraseNumber: 3 });
      expect(parseTrainerPath('#/Trainer/C/clip-1/P/12?x=1')).toEqual({ view: 'phrase', clipId: 'clip-1', phraseNumber: 12 });
    });

    it('falls back to the library or the clip for anything malformed, and never throws', () => {
      for (const h of ['', '#', '#studio', '#trainer/zzz', '#trainer/c', '#trainer/c/', '#trainer/c/%E0%A4%A']) expect(parseTrainerPath(h)).toEqual({ view: 'library' });
      expect(parseTrainerPath(null)).toEqual({ view: 'library' });
      expect(parseTrainerPath('#trainer/c/x/p/0')).toEqual({ view: 'clip', clipId: 'x' });
      expect(parseTrainerPath('#trainer/c/x/p/two')).toEqual({ view: 'clip', clipId: 'x' });
      expect(parseTrainerPath('#trainer/c/x/p/1.5')).toEqual({ view: 'clip', clipId: 'x' });
      expect(parseTrainerPath('#trainer/c/x/p')).toEqual({ view: 'clip', clipId: 'x' });
    });

    it('round-trips through trainerHash, including ids that need escaping', () => {
      const paths: TrainerPath[] = [
        { view: 'library' },
        { view: 'add' },
        { view: 'clip', clipId: 'a b/c?d' },
        { view: 'phrase', clipId: 'clip-9', phraseNumber: 7 },
      ];
      for (const p of paths) expect(parseTrainerPath(trainerHash(p))).toEqual(p);
      expect(trainerHash({ view: 'phrase', clipId: 'c', phraseNumber: 0 })).toBe('#trainer/c/c/p/1');
    });
  });

  it('tolerates a leading slash, case, whitespace and trailing parameters', () => {
    expect(parseRoute('#/results')).toBe('results');
    expect(parseRoute('#Practice')).toBe('practice');
    expect(parseRoute('#guide?section=health')).toBe('guide');
    expect(parseRoute('#settings/ai')).toBe('settings');
    expect(parseRoute('progress')).toBe('progress');
  });

  it('builds hashes that parse back to the same route', () => {
    for (const r of ROUTES) expect(parseRoute(routeHash(r))).toBe(r);
    expect(routeHash('results')).toBe('#results');
  });

  it('labels every route', () => {
    for (const r of ROUTES) expect(ROUTE_LABELS[r]).toMatch(/^[A-Z]/);
  });

  it('isRoute narrows strings', () => {
    expect(isRoute('studio')).toBe(true);
    expect(isRoute('Studio')).toBe(false);
  });

  it('says which phone tab a page belongs to', () => {
    for (const r of MORE_ROUTES) {
      expect(isMoreRoute(r)).toBe(true);
      expect(tabFor(r)).toBe('more');
    }
    for (const r of TAB_ROUTES) {
      expect(isMoreRoute(r)).toBe(false);
      expect(tabFor(r)).toBe(r);
    }
  });

  it('reads the section a link points at', () => {
    expect(parseSection('#guide/guide-vocal')).toBe('guide-vocal');
    expect(parseSection('#/Guide/Guide-Vocal?x=1')).toBe('guide-vocal');
    expect(parseSection('#guide')).toBeNull();
    expect(parseSection('#guide/')).toBeNull();
    expect(parseSection('#guide/a%20b')).toBeNull();
    expect(parseSection(null)).toBeNull();
  });

  describe('goTrainer', () => {
    afterEach(() => {
      window.location.hash = '';
    });

    it('sets the hash of a sub-view', () => {
      goTrainer({ view: 'phrase', clipId: 'c1', phraseNumber: 4 });
      expect(window.location.hash).toBe('#trainer/c/c1/p/4');
      goTrainer({ view: 'library' });
      expect(window.location.hash).toBe('#trainer');
    });
  });

  describe('Skills', () => {
    afterEach(() => {
      window.location.hash = '';
    });

    it('is a route of its own, second on the phone bar and right after the Trainer on the desktop bar; Results moves under More', () => {
      expect(parseRoute('#skills')).toBe('skills');
      expect(parseRoute('#skills/sequence?seed=7')).toBe('skills');
      expect(ROUTE_LABELS.skills).toBe('Skills');
      expect(TAB_ROUTES).toEqual(['trainer', 'skills', 'studio', 'progress', 'more']);
      expect(TOP_ROUTES).toEqual(['trainer', 'skills', 'studio', 'results', 'practice', 'progress', 'guide', 'settings']);
      expect(MORE_ROUTES).toEqual(['results', 'practice', 'guide', 'settings']);
      expect(tabFor('results')).toBe('more');
      expect(tabFor('skills')).toBe('skills');
    });

    it('reads every sub-view and the seed', () => {
      expect(parseSkillsPath('#skills')).toEqual({ view: 'hub', seed: null });
      for (const v of SKILLS_VIEWS) if (v !== 'hub') expect(parseSkillsPath(`#skills/${v}`)).toEqual({ view: v, seed: null });
      expect(parseSkillsPath('#skills/sequence?seed=7')).toEqual({ view: 'sequence', seed: 7 });
      expect(parseSkillsPath('#/Skills/Ear?Seed=42&x=1')).toEqual({ view: 'ear', seed: 42 });
      expect(parseSkillsPath('#skills?seed=3')).toEqual({ view: 'hub', seed: 3 });
      expect(parseSkillsPath('#skills/sing-intervals/extra')).toEqual({ view: 'sing-intervals', seed: null });
      expect(parseSkillsPath('#skills/pitch-test?seed=4294967295')).toEqual({ view: 'pitch-test', seed: 4294967295 });
    });

    it('falls back to the hub and a null seed for anything malformed, and never throws', () => {
      for (const h of ['', '#', '#trainer', '#skills/nowhere', '#skills/%E0%A4%A', null, undefined]) expect(parseSkillsPath(h).view).toBe('hub');
      for (const q of ['seed=-1', 'seed=1.5', 'seed=abc', 'seed=', 'seed=4294967296', 'seed=99999999999', 'seed=1e3']) {
        expect(parseSkillsPath(`#skills/ear?${q}`)).toEqual({ view: 'ear', seed: null });
      }
    });

    it('round-trips through skillsHash', () => {
      const paths: SkillsPath[] = [
        { view: 'hub', seed: null },
        { view: 'hub', seed: 5 },
        ...SKILLS_VIEWS.map((v) => ({ view: v, seed: null })),
        { view: 'sequence', seed: 0 },
        { view: 'workout', seed: 123456 },
      ];
      for (const p of paths) expect(parseSkillsPath(skillsHash(p))).toEqual(p);
      expect(skillsHash({ view: 'hub', seed: null })).toBe('#skills');
      expect(skillsHash({ view: 'sequence', seed: 7 })).toBe('#skills/sequence?seed=7');
      expect(skillsHash({ view: 'ear', seed: -3 })).toBe('#skills/ear');
      expect(skillsHash({ view: 'ear' })).toBe('#skills/ear');
    });

    it('goSkills sets the hash', () => {
      goSkills({ view: 'breath', seed: null });
      expect(window.location.hash).toBe('#skills/breath');
      goSkills({ view: 'hub' });
      expect(window.location.hash).toBe('#skills');
    });
  });
});
