#!/usr/bin/env node
// Layout check for the Trainer screens (and the pages W6 changed), in a real Chromium, against a Vite dev server this script starts on
// a free port. The screens run on the fake Trainer controller (scripts/ui-harness), so no audio, microphone or IndexedDB is involved.
//
//   node scripts/ui-layout-check.mjs [--out <dir>] [--only a,b] [--widths 320,390,430,1280] [--schemes light,dark] [--chromium <path>] [--json]
//
// For every screen x width x colour scheme it takes a full-page screenshot and checks, in the page:
//   - overflow     no horizontal page scroll, and nothing wider than the viewport outside a scroll container
//   - targets      on phone widths every control is at least 44 x 44 px (inline links in running text excepted)
//   - inputs       text inputs, selects and textareas use at least 16 px type (iOS zooms the page below that)
//   - contrast     visible text meets WCAG AA against the background it sits on (4.5:1, 3:1 for large text)
//   - clipped      text cut off by overflow:hidden without an ellipsis (a warning)
// Errors make the exit code 1. Screenshots go to the folder given by --out (default: the session scratchpad's plan/ui-shots).
// What it cannot tell you: how it feels under a thumb, real Safari rendering (WebKit is not installed here), or anything about audio.
// Needs the global Playwright (default /opt/node22/lib/node_modules/playwright, override with PLAYWRIGHT_MODULE). Only 127.0.0.1 is used.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(name);

const DEFAULT_OUT = '/tmp/claude-0/-home-user-connect-x/c7cf0764-cfef-502f-8c42-ff240fdbd2b3/scratchpad/plan/ui-shots';
const outDir = path.resolve(option('--out') ?? DEFAULT_OUT);
const widths = (option('--widths') ?? '320,390,430,1280').split(',').map(Number);
const schemes = (option('--schemes') ?? 'light,dark').split(',');
const only = option('--only')?.split(',');

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/', path.join(repo, 'node_modules') + path.sep].filter(Boolean);
  for (const base of candidates) {
    try {
      const req = createRequire(base.endsWith('/') || base.endsWith(path.sep) ? base : base + path.sep);
      return req('playwright');
    } catch {
      // try the next place
    }
  }
  throw new Error('Playwright was not found. Set PLAYWRIGHT_MODULE to the folder that contains node_modules/playwright (or install it globally).');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startVite() {
  const port = await freePort();
  const vite = path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--clearScreen', 'false'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The dev server stopped early:\n${log}`);
    try {
      const r = await fetch(`${base}/scripts/ui-harness/index.html`);
      if (r.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The dev server did not start in 60 s:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, stop: () => child.kill('SIGTERM') };
}

// ------------------------------------------------------------------------------------------------ the screens

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = (page) => page.evaluate(() => window.__controller.engines.at(-1) !== undefined);
const force = (page, patch, position) =>
  page.evaluate(
    ([p, pos]) => {
      const e = window.__controller.engines.at(-1);
      if (pos !== undefined) e.setPosition(pos);
      e.force(p);
    },
    [patch, position],
  );

async function ready(page, selector) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await sleep(120);
}

async function sing(page) {
  await page.click('.pc-sing');
  await page.waitForSelector('.rs', { timeout: 15000 });
  await sleep(150);
}

/** @type {{ name: string; s?: string; q?: string; hash: string; wait: string; prepare?: (page: import('playwright').Page) => Promise<void>; phoneOnly?: boolean }[]} */
const SCREENS = [
  { name: 'library', hash: '#trainer', wait: '.tr-clips' },
  { name: 'library-empty', s: 'empty', hash: '#trainer', wait: '.te' },
  { name: 'library-loading', s: 'loading', hash: '#trainer', wait: '.tr-loading' },
  { name: 'library-error', s: 'error', hash: '#trainer', wait: '.notice--error' },
  { name: 'library-memory', s: 'memory', hash: '#trainer', wait: '.notice--warn' },
  { name: 'add-sheet', hash: '#trainer/add', wait: '.imp-host > *' },
  {
    name: 'library-empty-ways',
    s: 'empty',
    hash: '#trainer',
    wait: '.te',
    prepare: async (page) => {
      await page.click('.te-ways summary');
      await sleep(100);
    },
  },
  { name: 'more', hash: '#more', wait: '.mo-list' },
  { name: 'clip', hash: '#trainer/c/fake-clip', wait: '.cl-phrases' },
  {
    name: 'clip-edit',
    hash: '#trainer/c/fake-clip',
    wait: '.cl-phrases',
    prepare: async (page) => {
      await page.click('text=Edit phrases');
      await page.waitForSelector('#cl-edit-h', { timeout: 10000 });
      await sleep(250);
    },
  },
  { name: 'clip-missing', hash: '#trainer/c/clip-missing', wait: '.notice--warn' },
  { name: 'clip-mix', hash: '#trainer/c/clip-jalen', wait: '.cl-phrases' },
  { name: 'clip-not-found', hash: '#trainer/c/nope', wait: '.page--clip' },
  { name: 'practice', hash: '#trainer/c/fake-clip/p/5', wait: '.pd' },
  { name: 'practice-new-phrase', hash: '#trainer/c/clip-daniel/p/2', wait: '.pd' },
  { name: 'practice-preparing', s: 'preparing', hash: '#trainer/c/fake-clip/p/5', wait: '.pr-preparing' },
  {
    name: 'practice-countin',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await force(page, { state: 'countin', countIn: 2 });
      await sleep(150);
    },
  },
  {
    name: 'practice-singing',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await force(page, { state: 'singing', countIn: null, liveMidi: 55, level: 0.6 }, 2.4);
      await sleep(400);
    },
  },
  {
    name: 'practice-looping',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await page.click('.ps-chip >> nth=3');
      await force(page, { state: 'listening' }, 2.6);
      await sleep(300);
    },
  },
  { name: 'practice-result-flat', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  {
    name: 'practice-result-flat-more',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await sing(page);
      await page.click('.rs-more');
      await sleep(150);
    },
  },
  {
    name: 'practice-result-flat-all',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await sing(page);
      await page.click('.rs-more');
      await page.click('.rs-more');
      await sleep(300);
    },
  },
  { name: 'practice-result-late', q: 'script=late', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  { name: 'practice-result-wrong-note', q: 'script=wrong-note', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  { name: 'practice-result-partial', q: 'script=partial', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  { name: 'practice-result-no-match', q: 'script=no-match', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  { name: 'practice-result-perfect', q: 'script=perfect', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: sing },
  { name: 'practice-interrupted', s: 'interrupted', hash: '#trainer/c/fake-clip/p/5', wait: '.pd', prepare: async (page) => (await page.click('.pc-sing'), await sleep(300)) },
  { name: 'practice-bluetooth', s: 'bluetooth', hash: '#trainer/c/fake-clip/p/5', wait: '.pd' },
  {
    name: 'practice-speaker-ask',
    s: 'speaker',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      // With no headphones the screen starts in "Listen, then sing"; choosing "Sing along" and tapping Sing asks first.
      // The choices are off until the phrase is ready (the radio is disabled, and a click on its label does nothing).
      await page.waitForSelector('.pc-sing:not([disabled])', { timeout: 10000 });
      await sleep(150);
      await page.locator('.pc-mode input[value="sing-along"]').check();
      await page.click('.pc-sing');
      await page.waitForSelector('.pc-ask', { timeout: 10000 });
      await sleep(150);
    },
  },
  {
    name: 'practice-error',
    hash: '#trainer/c/fake-clip/p/5',
    wait: '.pd',
    prepare: async (page) => {
      await force(page, { state: 'error', message: 'The microphone could not be started. Allow it for this site in Settings, then tap Try again.' });
      await sleep(150);
    },
  },
  {
    name: 'studio',
    hash: '#studio',
    wait: '.measure, .mt-clips, #measure-heading',
  },
  { name: 'progress', hash: '#progress', wait: '.pp-counts' },
  { name: 'settings', hash: '#settings', wait: '.st-trainer' },
  {
    name: 'settings-diagnostics',
    hash: '#settings/diagnostics',
    wait: '.page--diagnostics, .td-quick, .st-diag',
  },
  { name: 'guide', hash: '#guide', wait: '.prose' },
  { name: 'guide-getting-a-vocal', hash: '#guide/guide-vocal', wait: '#guide-vocal' },
];

// ------------------------------------------------------------------------------------------------ the checks, run in the page

/** Runs inside the page. `phone` turns on the 44 px target check. */
function inPageChecks(phone) {
  const issues = [];
  const add = (kind, el, detail, severity = 'error') => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    issues.push({ kind, severity, where: `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` "${text}"` : ''}`, detail });
  };
  const vw = document.documentElement.clientWidth;
  const hidden = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (c.display === 'none' || c.visibility === 'hidden') return true;
      if (p.hasAttribute('hidden') || p.getAttribute('aria-hidden') === 'true') return true;
      if (p.matches('.visually-hidden, .skip-link')) return true;
      if (p.matches('details:not([open]) > :not(summary)')) return true;
    }
    return false;
  };
  const clippedByAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX)) {
        const r = p.getBoundingClientRect();
        if (r.right <= vw + 1 && r.left >= -1) return true;
      }
    }
    return false;
  };

  // 1. overflow
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) issues.push({ kind: 'overflow', severity: 'error', where: 'page', detail: `the page is ${sw}px wide in a ${vw}px viewport` });
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || hidden(el)) continue;
    if ((r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el)) add('overflow', el, `spans ${Math.round(r.left)}..${Math.round(r.right)} in a ${vw}px viewport`);
  }

  // 2. target sizes (phones)
  if (phone) {
    const interactive = 'a[href], button, select, textarea, summary, label:has(input[type=checkbox]), label:has(input[type=radio]), input:not([type=hidden]):not([type=checkbox]):not([type=radio]), [role=button], [role=link]:not([aria-disabled=true])';
    for (const el of document.querySelectorAll(interactive)) {
      if (hidden(el)) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.tagName === 'A' && cs.display === 'inline') continue; // a link inside running text
      if (el.matches('input[type=file]') || el.closest('.filedrop-label')) continue;
      if (el.matches('label') && el.closest('.segmented-option') == null && el.querySelector('.tr-switch-label') == null && el.closest('.tr-switch') == null && el.querySelector('input') == null) continue;
      if (el.matches(':disabled') && !el.matches('[aria-pressed]')) continue;
      if (r.width < 43.5 || r.height < 43.5) add('target', el, `${Math.round(r.width)} x ${Math.round(r.height)} px`);
    }
  }

  // 3. input font size
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), select, textarea')) {
    if (hidden(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.99) add('input-font', el, `font size ${fs}px (iOS zooms the page under 16px)`);
  }

  // 4. contrast
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bottom) => {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const backdrop = (el) => {
    // Colours from the element up to the page, composited; null when a gradient or image is involved.
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.backgroundImage !== 'none') return null;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let acc = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const el = node.parentElement;
    if (!text || !el || seen.has(el) || hidden(el) || el.closest('svg, script, style')) continue;
    seen.add(el);
    if (el.closest(':disabled, [aria-disabled=true]')) continue;
    const cs = getComputedStyle(el);
    let opacity = 1;
    for (let p = el; p; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
    const bg = backdrop(el);
    if (!bg) continue;
    const fg = rgba(cs.color);
    const fgOver = over([fg[0], fg[1], fg[2], fg[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    const got = ratio(fgOver, bg);
    if (got < need - 0.01) add('contrast', el, `${got.toFixed(2)}:1 where ${need}:1 is needed (${size}px, ${cs.color} on rgb(${bg.slice(0, 3).map(Math.round).join(',')}))`);
  }

  // 5. clipped text
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') || hidden(el)) continue;
    const cs = getComputedStyle(el);
    if (!/(hidden|clip)/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && el.childElementCount === 0 && (el.textContent ?? '').trim()) add('clipped', el, `content ${el.scrollWidth}px in a ${el.clientWidth}px box`, 'warning');
  }
  return issues;
}

// ------------------------------------------------------------------------------------------------ run

async function main() {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startVite();
  const exe = option('--chromium') ?? process.env.CHROMIUM_PATH ?? undefined;
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox'] });
  const results = [];
  const consoleProblems = [];
  const screens = SCREENS.filter((s) => !only || only.includes(s.name));
  try {
    for (const scheme of schemes) {
      for (const width of widths) {
        const phone = width < 700;
        const context = await browser.newContext({
          viewport: { width, height: phone ? 844 : 800 },
          deviceScaleFactor: phone ? 2 : 1,
          isMobile: phone,
          hasTouch: phone,
          colorScheme: scheme,
          reducedMotion: 'no-preference',
        });
        for (const screen of screens) {
          const page = await context.newPage();
          const problems = [];
          page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
          page.on('console', (m) => {
            if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`);
          });
          const query = [screen.s ? `s=${screen.s}` : '', screen.q ?? ''].filter(Boolean).join('&');
          const url = `${server.base}/scripts/ui-harness/index.html${query ? `?${query}` : ''}${screen.hash}`;
          try {
            await page.goto(url, { waitUntil: 'load', timeout: 60000 });
            await ready(page, screen.wait);
            if (screen.prepare) await screen.prepare(page);
            await sleep(100);
            const issues = await page.evaluate(inPageChecks, phone);
            const file = `${screen.name}-${width}-${scheme}.png`;
            await page.screenshot({ path: path.join(outDir, file), fullPage: true });
            // What a person sees first (the sticky dock and the tab bar sit where they really sit), and after scrolling to the end.
            await page.screenshot({ path: path.join(outDir, file.replace('.png', '-view.png')) });
            const scrolls = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 40);
            if (scrolls) {
              await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
              await sleep(80);
              await page.screenshot({ path: path.join(outDir, file.replace('.png', '-end.png')) });
            }
            results.push({ screen: screen.name, width, scheme, file, issues });
            for (const p of problems) consoleProblems.push(`${screen.name} ${width} ${scheme}: ${p}`);
          } catch (err) {
            results.push({ screen: screen.name, width, scheme, file: null, issues: [{ kind: 'run', severity: 'error', where: screen.name, detail: String(err.message ?? err).split('\n')[0] }] });
            for (const p of problems) consoleProblems.push(`${screen.name} ${width} ${scheme}: ${p}`);
            try {
              await page.screenshot({ path: path.join(outDir, `FAILED-${screen.name}-${width}-${scheme}.png`), fullPage: true });
            } catch {
              // nothing to capture
            }
          } finally {
            await page.close();
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }

  const errors = results.flatMap((r) => r.issues.filter((i) => i.severity === 'error').map((i) => ({ ...i, screen: r.screen, width: r.width, scheme: r.scheme })));
  const warnings = results.flatMap((r) => r.issues.filter((i) => i.severity === 'warning').map((i) => ({ ...i, screen: r.screen, width: r.width, scheme: r.scheme })));
  if (flag('--json')) {
    console.log(JSON.stringify({ outDir, screens: screens.length, runs: results.length, errors, warnings, consoleProblems }, null, 2));
  } else {
    const group = (list) => {
      const byKey = new Map();
      for (const i of list) {
        const key = `${i.kind} | ${i.screen} | ${i.where} | ${i.detail}`;
        const cur = byKey.get(key) ?? { ...i, at: [] };
        cur.at.push(`${i.width}${i.scheme === 'dark' ? 'd' : 'l'}`);
        byKey.set(key, cur);
      }
      return [...byKey.values()];
    };
    for (const e of group(errors)) console.log(`ERROR   ${e.kind.padEnd(10)} ${e.screen}: ${e.where} - ${e.detail} [${e.at.join(' ')}]`);
    for (const w of group(warnings)) console.log(`warning ${w.kind.padEnd(10)} ${w.screen}: ${w.where} - ${w.detail} [${w.at.join(' ')}]`);
    for (const c of [...new Set(consoleProblems)]) console.log(`console ${c}`);
    console.log(`\n${results.length} screenshots in ${outDir}`);
    console.log(`${errors.length} errors, ${warnings.length} warnings over ${screens.length} screens x ${widths.length} widths x ${schemes.length} schemes.`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
