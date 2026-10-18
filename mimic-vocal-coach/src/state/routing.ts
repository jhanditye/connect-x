// Hash routing with bare tokens (#studio, #results, ...). Hash routing keeps the app working from
// a GitHub Pages subpath or a single-file build without server rewrites.

import { useCallback, useEffect, useState } from 'react';
import { SKILLS_VIEWS, type SkillsPath, type SkillsView } from '../skills/types';

export const ROUTES = ['trainer', 'skills', 'studio', 'results', 'practice', 'progress', 'guide', 'settings', 'more'] as const;
export type Route = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: Route = 'trainer';

/** Phone tab bar: five tabs. Everything else is reached through More. */
export const TAB_ROUTES: readonly Route[] = ['trainer', 'skills', 'studio', 'progress', 'more'];
/** Desktop top bar: every page except More (which only exists to hold these on a phone). */
export const TOP_ROUTES: readonly Route[] = ['trainer', 'skills', 'studio', 'results', 'practice', 'progress', 'guide', 'settings'];
/** What the More page lists (Results sits here on a phone since Skills took its tab). */
export const MORE_ROUTES: readonly Route[] = ['results', 'practice', 'guide', 'settings'];

export const ROUTE_LABELS: Record<Route, string> = {
  trainer: 'Trainer',
  skills: 'Skills',
  more: 'More',
  studio: 'Studio',
  results: 'Results',
  practice: 'Practice',
  progress: 'Progress',
  guide: 'Guide',
  settings: 'Settings',
};

export function isRoute(x: string): x is Route {
  return (ROUTES as readonly string[]).includes(x);
}

/** "#results" / "results" / "#/results" / "#Results?x=1" -> "results"; anything unknown -> the default route. */
export function parseRoute(hash: string | null | undefined): Route {
  const token = (hash ?? '')
    .replace(/^#\/?/, '')
    .split(/[?&/]/)[0]
    .trim()
    .toLowerCase();
  return isRoute(token) ? token : DEFAULT_ROUTE;
}

export function routeHash(route: Route): string {
  return `#${route}`;
}

/**
 * Where the Trainer is, from the part of the hash after "#trainer":
 *   #trainer                      library
 *   #trainer/add                  import sheet
 *   #trainer/c/<clipId>           clip detail
 *   #trainer/c/<clipId>/p/<n>     practice screen for phrase number n (1-based, as the screen shows it)
 */
export type TrainerPath =
  | { view: 'library' }
  | { view: 'add' }
  | { view: 'clip'; clipId: string }
  | { view: 'phrase'; clipId: string; phraseNumber: number };

function decodePart(part: string): string | null {
  try {
    const decoded = decodeURIComponent(part).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Anything that is not a well-formed trainer deep link falls back to the library; never throws. */
export function parseTrainerPath(hash: string | null | undefined): TrainerPath {
  const parts = (hash ?? '')
    .replace(/^#\/?/, '')
    .split('?')[0]
    .split('/')
    .filter((p) => p.length > 0);
  if (parts[0]?.trim().toLowerCase() !== 'trainer') return { view: 'library' };
  if (parts[1]?.toLowerCase() === 'add') return { view: 'add' };
  if (parts[1]?.toLowerCase() === 'c' && parts[2] !== undefined) {
    const clipId = decodePart(parts[2]);
    if (clipId === null) return { view: 'library' };
    if (parts[3]?.toLowerCase() === 'p' && parts[4] !== undefined) {
      const n = Number(parts[4]);
      if (Number.isInteger(n) && n >= 1) return { view: 'phrase', clipId, phraseNumber: n };
      return { view: 'clip', clipId };
    }
    return { view: 'clip', clipId };
  }
  return { view: 'library' };
}

/** Inverse of parseTrainerPath. */
export function trainerHash(path: TrainerPath): string {
  switch (path.view) {
    case 'library':
      return '#trainer';
    case 'add':
      return '#trainer/add';
    case 'clip':
      return `#trainer/c/${encodeURIComponent(path.clipId)}`;
    case 'phrase':
      return `#trainer/c/${encodeURIComponent(path.clipId)}/p/${Math.max(1, Math.round(path.phraseNumber))}`;
  }
}

export function navigate(route: Route): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash !== routeHash(route)) window.location.hash = routeHash(route);
}

/** Opens a Trainer sub-view (library, add sheet, clip, phrase). `navigate(route)` only knows the bare route tokens. */
export function goTrainer(path: TrainerPath): void {
  if (typeof window === 'undefined') return;
  const hash = trainerHash(path);
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** Results, Practice, Guide and Settings live under the More tab on a phone. */
export function isMoreRoute(route: Route): boolean {
  return (MORE_ROUTES as readonly string[]).includes(route);
}

/** The phone tab that should look current while `route` is showing (Results, Practice, Guide and Settings count as More). */
export function tabFor(route: Route): Route {
  return isMoreRoute(route) ? 'more' : route;
}

/**
 * "#guide/guide-vocal" -> "guide-vocal": the section of a long page a link points at. Only the part after the route token,
 * lower-cased and limited to letters, digits and dashes so it can be used as an element id; null when there is none.
 */
export function parseSection(hash: string | null | undefined): string | null {
  const parts = (hash ?? '')
    .replace(/^#\/?/, '')
    .split('?')[0]
    .split('/')
    .filter((p) => p.length > 0);
  const section = parts[1]?.toLowerCase();
  return section && /^[a-z0-9-]+$/.test(section) ? section : null;
}

// ---------------------------------------------------------------------------------------------
// Skills sub-views: #skills, #skills/pitch-test, #skills/sequence?seed=7 ... (src/skills/SPEC.md section 6)

const SKILLS_HUB: SkillsPath = Object.freeze({ view: 'hub', seed: null }) as SkillsPath;
const MAX_SEED = 0xffffffff;

function isSkillsView(x: string): x is SkillsView {
  return (SKILLS_VIEWS as readonly string[]).includes(x);
}

/** "?seed=7" -> 7: a whole number 0..2^32-1, anything else null. */
function parseSeed(query: string): number | null {
  for (const pair of query.split('&')) {
    const [k, v] = pair.split('=');
    if (k?.trim().toLowerCase() !== 'seed' || v === undefined) continue;
    const t = v.trim();
    if (!/^\d{1,10}$/.test(t)) return null;
    const n = Number(t);
    return Number.isInteger(n) && n >= 0 && n <= MAX_SEED ? n : null;
  }
  return null;
}

/**
 * Where the Skills section is, from the hash: "#skills" -> the hub, "#skills/sequence?seed=7" -> { view: 'sequence', seed: 7 }.
 * An unknown view is the hub; "hub" itself is not written in links. Never throws.
 */
export function parseSkillsPath(hash: string | null | undefined): SkillsPath {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q + 1);
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts[0]?.trim().toLowerCase() !== 'skills') return { ...SKILLS_HUB };
  const view = (parts[1] ?? '').trim().toLowerCase();
  return { view: isSkillsView(view) ? view : 'hub', seed: parseSeed(query) };
}

/** Inverse of parseSkillsPath: "#skills", "#skills/ear", "#skills/sequence?seed=7". */
export function skillsHash(path: Partial<SkillsPath> & Pick<SkillsPath, 'view'>): string {
  const base = path.view === 'hub' ? '#skills' : `#skills/${path.view}`;
  const seed = path.seed;
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED ? `${base}?seed=${seed}` : base;
}

/** Opens a Skills sub-view (sets the hash; the page follows on hashchange). */
export function goSkills(path: Partial<SkillsPath> & Pick<SkillsPath, 'view'>): void {
  if (typeof window === 'undefined') return;
  const hash = skillsHash(path);
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** The Skills sub-view from location.hash, updated on hashchange. */
export function useSkillsPath(): SkillsPath {
  const [path, setPath] = useState<SkillsPath>(() => (typeof window === 'undefined' ? { ...SKILLS_HUB } : parseSkillsPath(window.location.hash)));
  useEffect(() => {
    const onChange = () =>
      setPath((cur) => {
        const next = parseSkillsPath(window.location.hash);
        return next.view === cur.view && next.seed === cur.seed ? cur : next;
      });
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

/** The Trainer's sub-view from location.hash, updated on hashchange. */
export function useTrainerPath(): TrainerPath {
  const [path, setPath] = useState<TrainerPath>(() => (typeof window === 'undefined' ? { view: 'library' } : parseTrainerPath(window.location.hash)));
  useEffect(() => {
    const onChange = () => setPath(parseTrainerPath(window.location.hash));
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return path;
}

/** Current route from location.hash, updated on hashchange. */
export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => (typeof window === 'undefined' ? DEFAULT_ROUTE : parseRoute(window.location.hash)));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    onChange();
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((r: Route) => {
    setRoute(r);
    navigate(r);
  }, []);
  return [route, go];
}
