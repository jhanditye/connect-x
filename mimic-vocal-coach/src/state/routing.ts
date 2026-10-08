// Hash routing with bare tokens (#studio, #results, ...). Hash routing keeps the app working from
// a GitHub Pages subpath or a single-file build without server rewrites.

import { useCallback, useEffect, useState } from 'react';

export const ROUTES = ['trainer', 'studio', 'results', 'practice', 'progress', 'guide', 'settings', 'more'] as const;
export type Route = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: Route = 'trainer';

/** Phone tab bar: five tabs. Everything else is reached through More. */
export const TAB_ROUTES: readonly Route[] = ['trainer', 'studio', 'results', 'progress', 'more'];
/** Desktop top bar: every page except More (which only exists to hold these on a phone). */
export const TOP_ROUTES: readonly Route[] = ['trainer', 'studio', 'results', 'practice', 'progress', 'guide', 'settings'];
/** What the More page lists. */
export const MORE_ROUTES: readonly Route[] = ['practice', 'guide', 'settings'];

export const ROUTE_LABELS: Record<Route, string> = {
  trainer: 'Trainer',
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

/** Practice, Guide and Settings live under the More tab on a phone. */
export function isMoreRoute(route: Route): boolean {
  return (MORE_ROUTES as readonly string[]).includes(route);
}

/** The phone tab that should look current while `route` is showing (Practice, Guide and Settings count as More). */
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
