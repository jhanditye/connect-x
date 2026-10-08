#!/usr/bin/env node
// Runs the IndexedDB half of the clip store checks in real Chromium (not part of `npm test`).
//
//   node scripts/clip-store-browser/run.mjs
//
// What it does: bundles entry.mjs (which imports src/storage/clips.ts, clipStoreContract.ts and quota.ts) with rolldown,
// serves it on http://localhost:<port> (a secure context), opens it in headless Chromium through the globally installed
// Playwright, and prints PASS / FAIL / SKIP / INFO lines. Exit code 1 when anything fails.
// The storage quota cases use the DevTools protocol (Storage.overrideQuotaForOrigin) to make Chromium refuse writes.
//
// Finding things (override with environment variables):
//   PLAYWRIGHT_DIR    the folder that holds the playwright package (default: `npm root -g`, then /opt/node22/lib/node_modules)
//   CHROMIUM_PATH     a Chromium or Chrome binary (default: the newest /opt/pw-browsers/chromium-*/chrome-linux/chrome,
//                     else Playwright's own download)
// No dependency is added to the project: rolldown ships with Vite, Playwright is global.

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadPlaywright() {
  const roots = [];
  if (process.env.PLAYWRIGHT_DIR) roots.push(process.env.PLAYWRIGHT_DIR);
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // npm is not on the path; fall through to the known location.
  }
  roots.push('/opt/node22/lib/node_modules');
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'noop.js'))('playwright');
    } catch {
      // try the next root
    }
  }
  throw new Error(`Playwright is not installed globally (looked in ${roots.join(', ')}). Install it or set PLAYWRIGHT_DIR.`);
}

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = '/opt/pw-browsers';
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // no preinstalled browsers
  }
  return undefined;
}

const { chromium } = loadPlaywright();

const bundle = await rolldown({ input: path.join(here, 'entry.mjs'), platform: 'browser', logLevel: 'warn' });
const { output } = await bundle.generate({ format: 'iife' });
await bundle.close();
const code = output[0].code;

const server = http
  .createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><title>clip store checks</title><script src="/bundle.js"></script>');
    } else if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(code);
    } else {
      res.statusCode = 404;
      res.end();
    }
  })
  .listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
let failed = 0;
let passed = 0;
let skipped = 0;
try {
  const context = await browser.newContext();
  // localhost and 127.0.0.1 are different origins with separate storage: the quota cases get a clean one.
  for (const [host, part] of [['localhost', 'main'], ['127.0.0.1', 'quota']]) {
    const origin = `http://${host}:${port}`;
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
    const cdp = await context.newCDPSession(page);
    await page.exposeFunction('__setQuota', async (bytes) => {
      await cdp.send('Storage.overrideQuotaForOrigin', bytes === null ? { origin } : { origin, quotaSize: bytes });
    });
    await page.goto(origin);
    const result = await page.evaluate((p) => window.runClipStoreChecks(p), part);
    if (part === 'main') {
      // A real reload: what one page load stored, the next one reads.
      const info = await page.evaluate(() => window.persistWrite());
      await page.reload();
      const back = await page.evaluate((i) => window.persistRead(i), info);
      const ok =
        back.title === 'Kept across a reload' &&
        back.samples === 44100 &&
        JSON.stringify(back.attempts) === '[["a1",true]]' &&
        back.recording === 500 &&
        JSON.stringify(back.calibration) === '{"wired":91}' &&
        back.usage.audioBytes === 25 * 44100 * 2 + 1000;
      result.lines.push(ok ? 'PASS persistence: clip, audio, attempt, recording and meta survive a page reload' : `FAIL persistence: ${JSON.stringify(back)}`);
      if (!ok) result.failed++;
    }
    console.log(result.lines.join('\n'));
    passed += result.lines.filter((l) => l.startsWith('PASS')).length;
    skipped += result.lines.filter((l) => l.startsWith('SKIP')).length;
    failed += result.failed;
    await page.close();
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
} catch (err) {
  console.log('HARNESS ERROR', err);
  failed = failed || 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
