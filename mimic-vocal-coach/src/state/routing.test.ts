import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTE, isRoute, parseRoute, ROUTE_LABELS, ROUTES, routeHash } from './routing';

describe('routing', () => {
  it('parses bare hash tokens', () => {
    for (const r of ROUTES) expect(parseRoute(`#${r}`)).toBe(r);
  });

  it('defaults to the studio for empty or unknown hashes', () => {
    expect(DEFAULT_ROUTE).toBe('studio');
    expect(parseRoute('')).toBe('studio');
    expect(parseRoute('#')).toBe('studio');
    expect(parseRoute(null)).toBe('studio');
    expect(parseRoute(undefined)).toBe('studio');
    expect(parseRoute('#nowhere')).toBe('studio');
    expect(parseRoute('#main')).toBe('studio');
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
});
