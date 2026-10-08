// The page's Content-Security-Policy is what makes "no audio leaves the device" a browser-enforced fact, so pin it down: the only
// remote host is the optional AI coach, nothing can post a form or change the base URL, and the single-file build's inline module,
// the blob/data workers and the inlined fonts still run.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);

function directives(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of (meta?.[1] ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe('index.html Content-Security-Policy', () => {
  it('is a meta tag placed before any script or stylesheet', () => {
    expect(meta).not.toBeNull();
    const at = html.indexOf('Content-Security-Policy');
    expect(at).toBeGreaterThan(0);
    expect(html.indexOf('<script')).toBeGreaterThan(at);
    expect(html.indexOf('<link')).toBeGreaterThan(at);
  });

  it('starts from nothing allowed', () => {
    expect(directives().get('default-src')).toEqual(["'none'"]);
  });

  it('lets the app talk to this origin and the optional AI coach only', () => {
    const connect = directives().get('connect-src') ?? [];
    expect(connect).toContain("'self'");
    expect(connect).toContain('https://api.anthropic.com');
    expect(connect.filter((v) => /^(https?|wss?):/.test(v))).toEqual(['https://api.anthropic.com']);
    expect(connect).not.toContain('*');
  });

  it('allows no remote host for anything else (images, media, fonts, styles, workers, manifest)', () => {
    const d = directives();
    for (const name of ['script-src', 'worker-src', 'style-src', 'font-src', 'img-src', 'media-src', 'manifest-src']) {
      const values = d.get(name) ?? [];
      expect(values.length, name).toBeGreaterThan(0);
      expect(values.filter((v) => /^(https?|wss?):|^\*$/.test(v)), name).toEqual([]);
    }
  });

  it('keeps the builds working: blob workers and worklets, data workers and fonts, the single file\'s inline module', () => {
    const d = directives();
    expect(d.get('worker-src')).toEqual(expect.arrayContaining(["'self'", 'blob:', 'data:']));
    expect(d.get('script-src')).toEqual(expect.arrayContaining(["'self'", 'blob:', "'unsafe-inline'"]));
    expect(d.get('font-src')).toEqual(expect.arrayContaining(["'self'", 'data:']));
    expect(d.get('media-src')).toContain('blob:');
    expect(d.get('img-src')).toEqual(expect.arrayContaining(['data:', 'blob:']));
  });

  it('lets on-device vocal isolation compile WebAssembly and load its worker and files from this origin, and nothing more', () => {
    const d = directives();
    const script = d.get('script-src') ?? [];
    expect(script).toContain("'wasm-unsafe-eval'");
    // WebAssembly only: eval() and new Function() stay blocked.
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain("'strict-dynamic'");
    // The module worker, the runtime's loader and the model all come from the page's own origin.
    expect(d.get('worker-src')).toContain("'self'");
    expect(script).toContain("'self'");
    expect(d.get('connect-src')).toContain("'self'");
    // Nothing else was opened up to make room for it.
    expect(d.get('script-src')?.filter((v) => /^(https?|wss?):|^\*$/.test(v))).toEqual([]);
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('object-src')).toBeUndefined(); // default-src 'none' covers plug-ins
  });

  it('forbids a <base> change and form posts', () => {
    const d = directives();
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
  });

  it('says so, instead of leaving a blank page, when the app script cannot start', () => {
    expect(html).toMatch(/Mimic could not start/);
    expect(html).toMatch(/iOS 16\.4/);
  });
});
