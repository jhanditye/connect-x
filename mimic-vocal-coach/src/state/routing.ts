// Hash routing with bare tokens (#studio, #results, ...). Hash routing keeps the app working from
// a GitHub Pages subpath or a single-file build without server rewrites.

import { useCallback, useEffect, useState } from 'react';

export const ROUTES = ['studio', 'results', 'practice', 'progress', 'guide', 'settings'] as const;
export type Route = (typeof ROUTES)[number];
export const DEFAULT_ROUTE: Route = 'studio';

export const ROUTE_LABELS: Record<Route, string> = {
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

export function navigate(route: Route): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash !== routeHash(route)) window.location.hash = routeHash(route);
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
