// Layout rules that were broken once and are cheap to pin down in the style sheets (the browser checks live in scripts/ui-layout-check.mjs).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
const trainer = readFileSync(new URL('../src/styles/trainer.css', import.meta.url), 'utf8');

function rule(css: string, selector: string): string {
  const i = css.indexOf(`\n${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}

describe('style sheet rules', () => {
  it('the update banner scrolls with the page: sticky under the sticky top bar covered the bar and took a fifth of the screen', () => {
    expect(rule(app, '.update-banner')).not.toMatch(/position:\s*sticky/);
    expect(rule(app, '.update-banner')).not.toMatch(/position:\s*fixed/);
  });

  it('the top bar grows with large text instead of clipping the wordmark', () => {
    expect(rule(app, '.topbar-inner')).toMatch(/min-height:\s*56px/);
    expect(rule(app, '.topbar-inner')).not.toMatch(/\n\s*height:/);
  });

  it('tab labels shrink with the width instead of being cut with an ellipsis at large text sizes', () => {
    expect(rule(app, '.nav-list--tabs .nav-link')).toMatch(/font-size:\s*min\(0\.6875rem,\s*3\.2vw\)/);
  });

  it('the Guide contents entries are blocks of their own height, 44px on touch screens, so their boxes cannot overlap', () => {
    expect(rule(app, '.guide-toc .link-button')).toMatch(/display:\s*flex/);
    expect(app).toMatch(/@media \(pointer: coarse\) \{[\s\S]*\.guide-toc \.link-button \{\s*min-height: 44px/);
  });

  it('Progress clip rows wrap, and the practice buttons never squash their icons', () => {
    expect(rule(trainer, '.pp-clip-head')).toMatch(/flex-wrap:\s*wrap/);
    expect(trainer).toMatch(/\.pc-listen svg,\s*\.pc-sing svg \{\s*flex: none/);
  });

  it('aria-disabled controls look disabled too (they replace the disabled attribute so focus is kept)', () => {
    expect(trainer).toMatch(/\.pc-sing\[aria-disabled='true'\]/);
    expect(trainer).toMatch(/\.tr-chip\[aria-disabled='true'\]/);
  });
});
