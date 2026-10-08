import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'duplex-check.mjs');

describe('scripts/duplex-check.mjs', () => {
  it('parses (the Chromium run itself is a manual step: node scripts/duplex-check.mjs)', () => {
    const r = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('only ever talks to 127.0.0.1 and never fetches anything', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
