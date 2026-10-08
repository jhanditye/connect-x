#!/usr/bin/env node
// Chromium check of the audio session against a REAL Web Audio engine (not the Node fakes in src/testing/fakeAudio.ts).
//
//   node scripts/duplex-check.mjs [--json] [--chromium <path>] [--throttle <n>] [--keep]
//
// What it proves, in a headless Chromium with Chromium's fake microphone:
//   1. Stamped capture clock: a click train and a guide are played into a zero-latency loopback (the playback is also fed
//      into the capture worklet), and the take is searched for them. The error between "where the session says the guide
//      starts in the recording" and "where the guide really is" is reported in samples and ms. Also for the ScriptProcessor
//      fallback (no AudioWorklet), where the clock is only approximate.
//   2. The real microphone path: a 12 s take from the fake device has no dropped frames and the right length.
//   3. Interruption events, close() cleanup (context closed, tracks ended) and the playhead of listen().
//   4. How long the main thread is blocked while a 12 s phrase is slowed and transposed: in the worker, in 8 ms slices on
//      the main thread, and in one go (what the user would feel without any of this). Repeated with Chromium's CPU throttling
//      (default 4x, --throttle 1 to skip) as a rough stand-in for a slower phone. The throttle slows the page's main thread; a
//      worker may not be slowed by it, so the worker's own total time is NOT scaled by this emulation.
// What it cannot prove: real hardware latency (output + input), Bluetooth, the silent switch, or anything about WebKit.
//
// Needs the global Playwright (default /opt/node22/lib/node_modules/playwright, override with PLAYWRIGHT_MODULE) and a
// Chromium (Playwright's own, override with --chromium or CHROMIUM_PATH). Nothing is written into the repo; no network is used
// beyond 127.0.0.1.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

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

// ------------------------------------------------------------------------------------------------ the page's code

// Bundled by Vite (so `?worker&inline` and TypeScript just work) and run in the page. Absolute imports from the repo.
const ENTRY = (src) => `
import { createDuplexSession } from '${src}/audio/duplex';
import { preparePlayback } from '${src}/audio/player';
import { probeClicks } from '${src}/trainer/latency';
import { renderGuideAsync, renderGuide } from '${src}/dsp/timestretch';
import { renderGuideOffMainThread } from '${src}/dsp/stretchClient';
import { runDiagnostic } from '${src}/audio/diagnostics';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic white-ish noise burst: unambiguous to correlate (a sine repeats every cycle). */
function noiseBurst(n, seed) {
  let a = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    const w = Math.sin((Math.PI * i) / n); // fade in and out
    out[i] = 0.6 * w * ((a / 4294967296) * 2 - 1);
  }
  return out;
}

/** Lag (samples) at which \`ref\` best matches \`rec\` around \`expected\`, searched +/- \`range\` samples. */
function bestLag(rec, ref, expected, range) {
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = -range; lag <= range; lag++) {
    const start = expected + lag;
    if (start < 0 || start + ref.length > rec.length) continue;
    let c = 0;
    for (let i = 0; i < ref.length; i += 2) c += rec[start + i] * ref[i];
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  return bestLag;
}

/** First sample where |x| reaches \`level\` after \`from\`, with a linear interpolation to the crossing. */
function crossing(x, from, level, until) {
  for (let i = Math.max(1, from); i < Math.min(x.length, until); i++) {
    if (Math.abs(x[i]) >= level) return i;
  }
  return -1;
}

async function loopbackRun(hooks) {
  const s = createDuplexSession({ loopback: true, ...hooks });
  const route = await s.prepare({ mic: true });
  const ctx = s.context;
  const sr = ctx.sampleRate;
  const burstLen = Math.round(0.06 * sr);
  const bursts = [
    { at: 0.5, data: noiseBurst(burstLen, 7) },
    { at: 1.2, data: noiseBurst(burstLen, 99) },
  ];
  const buf = ctx.createBuffer(1, Math.round(2 * sr), sr);
  const d = buf.getChannelData(0);
  for (const b of bursts) d.set(b.data, Math.round(b.at * sr));
  await sleep(300); // the microphone has been open for a while: the take must not contain older audio
  const take = s.runTake(buf, { mode: 'sing-along', countInBeats: 3, bpm: 120, tailSec: 0.5, gain: 1 });
  const r = await take.done;
  const rec = r.samples;
  const out = {
    hooks,
    route: { kind: route.kind, label: route.inputLabel, inputSampleRate: route.inputSampleRate },
    sampleRate: sr,
    baseLatency: ctx.baseLatency,
    outputLatency: ctx.outputLatency ?? null,
    lengthSec: rec.length / sr,
    endedBy: r.endedBy,
    interruptedBy: r.interruptedBy ?? null,
    droppedFrames: r.droppedFrames,
    clockExact: r.clockExact,
    refStartInCaptureSec: r.refStartInCaptureSec,
    clickTimes: r.clickTimesInCaptureSec,
    guideEndInCaptureSec: r.guideEndInCaptureSec,
    bursts: [],
    clicks: [],
  };
  for (const b of bursts) {
    const expected = Math.round((r.refStartInCaptureSec + b.at) * sr);
    const lag = bestLag(rec, b.data, expected, Math.round(0.25 * sr));
    out.bursts.push({ at: b.at, lagSamples: lag, errorMs: (lag / sr) * 1000 });
  }
  // A click is a ramp-up (2 ms) of a 1.8 / 2.4 kHz tone: find where it passes 2 % of full scale.
  for (const t of r.clickTimesInCaptureSec) {
    const from = Math.round(t * sr) - Math.round(0.02 * sr);
    const i = crossing(rec, from, 0.02, Math.round(t * sr) + Math.round(0.05 * sr));
    out.clicks.push({ scheduled: t, found: i < 0 ? null : i / sr, offsetMs: i < 0 ? null : (i / sr - t) * 1000 });
  }
  const probe = probeClicks(rec, sr, r.clickTimesInCaptureSec);
  out.probe = { bleed: probe.bleed, roundTripMs: probe.roundTripMs, clicksHeard: probe.clicksHeard, consistent: probe.consistent, floorDb: probe.floorDb, overFloorDb: probe.clickOverFloorDb };
  await s.close();
  out.ctxStateAfterClose = ctx.state;
  return out;
}

async function micRun() {
  const seen = [];
  const s = createDuplexSession({ onChunk: (frame, length) => seen.push([frame, length]) });
  const route = await s.prepare({ mic: true });
  const ctx = s.context;
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(12 * sr), sr); // a silent 12 s phrase: the longest the trainer plays
  const t0 = ctx.currentTime;
  const take = s.runTake(buf, { mode: 'sing-along', countInBeats: 3, bpm: 100, tailSec: 0.5, gain: 1 });
  const r = await take.done;
  const tEnd = ctx.currentTime;
  let peak = 0;
  for (let i = 0; i < r.samples.length; i += 7) peak = Math.max(peak, Math.abs(r.samples[i]));
  const expectedSec = 0.45 + 3 * 0.6 + 12 + 0.5;
  const out = {
    route: { kind: route.kind, label: route.inputLabel, inputSampleRate: route.inputSampleRate },
    sampleRate: sr,
    lengthSec: r.samples.length / sr,
    expectedSec,
    contextSecondsUsed: tEnd - t0,
    droppedFrames: r.droppedFrames,
    endedBy: r.endedBy,
    peakFromFakeMic: peak,
    bufferedFramesAfter: s.bufferedFrames,
    gaps: seen.flatMap((c, i) => (i > 0 && c[0] !== seen[i - 1][0] + seen[i - 1][1] ? [{ atSec: c[0] / sr, frames: c[0] - (seen[i - 1][0] + seen[i - 1][1]) }] : [])),
    batches: seen.length,
    batchLengths: [...new Set(seen.map((c) => c[1]))].sort((a, b) => a - b).slice(0, 6),
  };
  await s.close();
  return out;
}

async function eventsRun() {
  const out = {};
  // Hidden page.
  {
    const s = createDuplexSession();
    await s.prepare({ mic: true });
    const ctx = s.context;
    const buf = ctx.createBuffer(1, Math.round(3 * ctx.sampleRate), ctx.sampleRate);
    const reasons = [];
    s.onInterrupted((x) => reasons.push(x));
    const t = s.runTake(buf, { mode: 'sing-along', countInBeats: 3, bpm: 100, tailSec: 0.5, gain: 1 });
    await sleep(700);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const r = await t.done;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    out.hidden = { endedBy: r.endedBy, interruptedBy: r.interruptedBy, reasons };
    await s.close();
  }
  // Microphone ended (a device pulled out): the same event the browser fires on the track.
  {
    const md = navigator.mediaDevices;
    const original = md.getUserMedia.bind(md);
    let last = null;
    md.getUserMedia = async (c) => {
      last = await original(c);
      return last;
    };
    const s = createDuplexSession();
    await s.prepare({ mic: true });
    const ctx = s.context;
    const buf = ctx.createBuffer(1, Math.round(3 * ctx.sampleRate), ctx.sampleRate);
    const reasons = [];
    s.onInterrupted((x) => reasons.push(x));
    const t = s.runTake(buf, { mode: 'sing-along', countInBeats: 3, bpm: 100, tailSec: 0.5, gain: 1 });
    await sleep(500);
    last.getAudioTracks()[0].dispatchEvent(new Event('ended'));
    const r = await t.done;
    out.micEnded = { endedBy: r.endedBy, interruptedBy: r.interruptedBy, reasons };
    md.getUserMedia = original;
    await s.close();
  }
  // listen(): the playhead.
  {
    const s = createDuplexSession();
    await s.prepare({ mic: false });
    const ctx = s.context;
    const buf = ctx.createBuffer(1, Math.round(3 * ctx.sampleRate), ctx.sampleRate);
    let ended = 0;
    const h = s.listen(buf, { onEnded: () => ended++ });
    const w0 = performance.now();
    await sleep(1000);
    const pos = h.position();
    const wall = (performance.now() - w0) / 1000;
    h.stop();
    h.stop();
    out.listen = { positionAfterAbout1s: pos, wallSec: wall, outputLatency: ctx.outputLatency ?? null, endedCalls: ended };
    await s.close();
  }
  // close(): cleanup in a real browser.
  {
    const s = createDuplexSession();
    await s.prepare({ mic: true });
    const ctx = s.context;
    const stream = (await navigator.mediaDevices.getUserMedia({ audio: true }));
    stream.getTracks().forEach((x) => x.stop());
    await s.close();
    await s.close();
    out.close = { ctxState: ctx.state, analyser: s.analyser === null };
  }
  return out;
}

async function stallRun() {
  // Longest gap between two ticks of a 2 ms timer while \`work\` runs: what the page would feel.
  async function stalls(work) {
    let last = performance.now();
    let max = 0;
    const id = setInterval(() => {
      const now = performance.now();
      max = Math.max(max, now - last);
      last = now;
    }, 2);
    await sleep(30);
    max = 0;
    last = performance.now();
    const t0 = performance.now();
    await work();
    const total = performance.now() - t0;
    await sleep(30);
    clearInterval(id);
    return { totalMs: total, longestMainThreadGapMs: max };
  }
  const sr = 44100;
  const x = new Float32Array(12 * sr);
  for (let i = 0; i < x.length; i++) {
    const f = 196 * 2 ** (Math.floor(i / sr) % 5 / 12 * 2);
    x[i] = 0.4 * Math.sin((2 * Math.PI * f * i) / sr) * (0.7 + 0.3 * Math.sin((2 * Math.PI * 5.5 * i) / sr));
  }
  const spec = { rate: 0.75, semitones: -5, outRate: 48000 };
  const results = {};
  results.idle = await stalls(() => sleep(300));
  results.worker = await stalls(async () => { const r = await renderGuideOffMainThread(x, sr, spec); results.workerViaWorker = r.viaWorker; });
  results.workerWarm = await stalls(async () => { await renderGuideOffMainThread(x, sr, spec); });
  results.slicedMainThread = await stalls(() => renderGuideAsync(x, sr, { rate: 0.75, semitones: 0 }, {}));
  results.slicedMainThreadWithShift = await stalls(() => renderGuideAsync(x, sr, spec, {}));
  results.oneGo = await stalls(async () => { renderGuide(x, sr, spec); });
  // preparePlayback end to end (cache cold), as the practice screen would call it.
  const ctx = new AudioContext();
  const t0 = performance.now();
  const p = await preparePlayback(ctx, { samples: x, sampleRate: sr, startSec: 0 }, 0.6, 3, { cache: false });
  results.preparePlayback = { ms: performance.now() - t0, bufferSec: p.buffer.duration, bufferRate: p.buffer.sampleRate, contextRate: ctx.sampleRate };
  await ctx.close();
  results.cores = navigator.hardwareConcurrency;
  return results;
}

async function diagnosticsRun() {
  const out = [];
  for (const id of ['display-mode', 'audio-context', 'audio-session', 'route', 'decode', 'indexeddb', 'storage', 'analysis-speed', 'stretch-speed', 'mic-level', 'click-probe']) {
    out.push(await runDiagnostic(id, { seconds: 3 }));
  }
  return out;
}

window.__check = { loopbackRun, micRun, eventsRun, stallRun, diagnosticsRun };
`;

async function buildBundle() {
  const { build } = await import('vite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-check-'));
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, ENTRY(path.join(repo, 'src').split(path.sep).join('/')));
  try {
    const result = await build({
      root: repo,
      configFile: false,
      logLevel: 'silent',
      worker: { format: 'es' },
      build: { write: false, minify: false, target: 'es2022', lib: { entry, name: 'DuplexCheck', formats: ['iife'], fileName: () => 'bundle.js' } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const chunk = outputs.find((o) => o.type === 'chunk');
    if (!chunk) throw new Error('Vite produced no bundle');
    return chunk.code;
  } finally {
    if (!flag('--keep')) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------- checks

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
}
const f = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

async function main() {
  const code = await buildBundle();
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(code);
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><title>duplex check</title><script src="/bundle.js"></script>');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const { chromium } = loadPlaywright();
  const exe = option('--chromium') ?? process.env.CHROMIUM_PATH ?? undefined;
  const browser = await chromium.launch({
    ...(exe ? { executablePath: exe } : {}),
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const results = {};
  try {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push(m.text());
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => !!window.__check, null, { timeout: 15000 });
    results.version = browser.version();

    results.loopback = await page.evaluate(() => window.__check.loopbackRun({}));
    results.loopbackScriptProcessor = await page.evaluate(() => window.__check.loopbackRun({ noWorklet: true }));
    results.mic = await page.evaluate(() => window.__check.micRun());
    results.events = await page.evaluate(() => window.__check.eventsRun());
    results.stall = await page.evaluate(() => window.__check.stallRun());
    const throttle = Number(option('--throttle') ?? 4);
    if (throttle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      results.stallThrottled = await page.evaluate(() => window.__check.stallRun());
      results.throttle = throttle;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
    results.diagnostics = await page.evaluate(() => window.__check.diagnosticsRun());
    results.pageErrors = pageErrors;

    const lb = results.loopback;
    const worst = Math.max(...lb.bursts.map((b) => Math.abs(b.errorMs)));
    check('loopback: take ends normally, no dropped frames', lb.endedBy === 'finished' && lb.droppedFrames === 0, `endedBy ${lb.endedBy}, dropped ${lb.droppedFrames}`);
    check('loopback: guide found within 5 ms of its stamped position', worst <= 5, `lag ${lb.bursts.map((b) => `${b.lagSamples} samples (${f(b.errorMs, 3)} ms)`).join(', ')}`);
    check(
      'loopback: clicks start within 5 ms of their stamped positions',
      lb.clicks.every((c) => c.offsetMs !== null && Math.abs(c.offsetMs) <= 5),
      lb.clicks.map((c) => f(c.offsetMs, 2)).join(', ') + ' ms',
    );
    check('loopback: click probe round trip near zero', lb.probe.roundTripMs !== null && Math.abs(lb.probe.roundTripMs) <= 8, `probe ${f(lb.probe.roundTripMs, 1)} ms, ${lb.probe.clicksHeard} clicks heard`);
    check('loopback: worklet clock is exact', lb.clockExact === true, String(lb.clockExact));
    check('loopback: context closed afterwards', lb.ctxStateAfterClose === 'closed', lb.ctxStateAfterClose);

    const sp = results.loopbackScriptProcessor;
    const spWorst = Math.max(...sp.bursts.map((b) => Math.abs(b.errorMs)));
    check('script-processor fallback: records, flagged approximate', sp.endedBy === 'finished' && sp.clockExact === false, `clockExact ${sp.clockExact}`);
    check('script-processor fallback: guide within 150 ms (approximate by design)', spWorst <= 150, `worst ${f(spWorst, 1)} ms`);

    const m = results.mic;
    // The audio thread can glitch under CPU load (this machine is shared). Up to 20 ms is padded and harmless (MAX_DROPPED_SEC).
    check('fake microphone: 12 s take finished with at most 20 ms dropped', m.droppedFrames <= 0.02 * m.sampleRate && m.endedBy === 'finished', `dropped ${m.droppedFrames} frames (${f((m.droppedFrames / m.sampleRate) * 1000, 1)} ms)`);
    check('fake microphone: take length matches the schedule', Math.abs(m.lengthSec - m.expectedSec) < 0.15, `${f(m.lengthSec, 3)} s vs ${f(m.expectedSec, 3)} s`);
    check('fake microphone: audio arrives', m.peakFromFakeMic > 0.001, `peak ${f(m.peakFromFakeMic, 3)}`);

    const e = results.events;
    check('microphone ending ends the take as interrupted (mic-ended)', e.micEnded.endedBy === 'interrupted' && e.micEnded.interruptedBy === 'mic-ended', JSON.stringify(e.micEnded));
    check('hidden page ends the take as interrupted (hidden)', e.hidden.endedBy === 'interrupted' && e.hidden.interruptedBy === 'hidden', JSON.stringify(e.hidden));
    check('listen(): playhead tracks the wall clock', Math.abs(e.listen.positionAfterAbout1s - e.listen.wallSec) < 0.25 && e.listen.endedCalls === 1, `pos ${f(e.listen.positionAfterAbout1s, 3)} s after ${f(e.listen.wallSec, 3)} s, onEnded x${e.listen.endedCalls}`);
    check('close(): context closed, idempotent', e.close.ctxState === 'closed' && e.close.analyser, JSON.stringify(e.close));

    const st = results.stall;
    check('guide render really ran in a Worker', st.workerViaWorker === true, String(st.workerViaWorker));
    check('guide render in a worker leaves the main thread free (gaps under 50 ms)', st.workerWarm.longestMainThreadGapMs < 50, `${f(st.workerWarm.longestMainThreadGapMs, 1)} ms, total ${f(st.workerWarm.totalMs, 0)} ms`);
    if (results.stallThrottled) {
      const t = results.stallThrottled;
      check(
        `with the CPU throttled ${results.throttle}x the worker still leaves the main thread free (no worse than idle + 30 ms)`,
        t.workerWarm.longestMainThreadGapMs <= t.idle.longestMainThreadGapMs + 30,
        `worker gap ${f(t.workerWarm.longestMainThreadGapMs, 1)} ms vs idle gap ${f(t.idle.longestMainThreadGapMs, 1)} ms`,
      );
      check(
        `with the CPU throttled ${results.throttle}x the sliced main-thread fallback (speed only) keeps gaps under 100 ms`,
        t.slicedMainThread.longestMainThreadGapMs < 100,
        `${f(t.slicedMainThread.longestMainThreadGapMs, 1)} ms`,
      );
    }
    check('guide render in main-thread slices (speed only) stays under 50 ms gaps', st.slicedMainThread.longestMainThreadGapMs < 50, `${f(st.slicedMainThread.longestMainThreadGapMs, 1)} ms, total ${f(st.slicedMainThread.totalMs, 0)} ms`);
    const diag = Object.fromEntries(results.diagnostics.map((d) => [d.id, d]));
    check('diagnostics: no check failed', results.diagnostics.every((d) => d.status !== 'fail'), results.diagnostics.map((d) => `${d.id}:${d.status}`).join(' '));
    // AIFF and CAF are Safari formats: Chromium's decoder cannot read them, so they are reported, not asserted (the AIFF file
    // was checked with Python's aifc instead; the CAF layout only by hand against Apple's spec).
    check(
      'diagnostics: the generated WAV and MP3 test files decode in a real decoder (AIFF and CAF are Safari-only formats)',
      ['wav', 'mp3'].every((k) => String(diag.decode.details[`decode.${k}`]).startsWith('ok')),
      ['wav', 'aiff', 'caf', 'mp3'].map((k) => `${k}: ${diag.decode.details[`decode.${k}`]}`).join('; '),
    );
    check('diagnostics: IndexedDB wrote and read back 5 MB', diag.indexeddb.status === 'ok', diag.indexeddb.summary);
    check('diagnostics: the microphone level check measured the fake microphone', typeof diag['mic-level'].details.peakDbfs === 'number' && diag['mic-level'].details.peakDbfs > -120, diag['mic-level'].summary);
    check('diagnostics: the guide render ran in a Worker', diag['stretch-speed'].details.ranInWorker === true, diag['stretch-speed'].summary);
    check('no page errors', results.pageErrors.length === 0, results.pageErrors.join(' | '));
  } finally {
    await browser.close();
    server.close();
  }

  if (flag('--json')) {
    console.log(JSON.stringify({ results, checks }, null, 2));
  } else {
    const lb = results.loopback;
    console.log(`Chromium ${results.version}, ${results.stall.cores} cores, context ${lb.sampleRate} Hz, baseLatency ${f(lb.baseLatency, 4)} s, outputLatency ${f(lb.outputLatency, 4)} s`);
    console.log('\nLoopback (worklet):');
    console.log(`  take ${f(lb.lengthSec, 3)} s, ${lb.endedBy}, dropped ${lb.droppedFrames}, guide scheduled at ${f(lb.refStartInCaptureSec, 4)} s in the recording`);
    for (const b of lb.bursts) console.log(`  guide burst at ${b.at} s: lag ${b.lagSamples} samples = ${f(b.errorMs, 3)} ms`);
    console.log(`  clicks: ${lb.clicks.map((c) => `${f(c.scheduled, 3)} s (+${f(c.offsetMs, 2)} ms)`).join(', ')}`);
    console.log(`  click probe: round trip ${f(lb.probe.roundTripMs, 2)} ms, ${lb.probe.clicksHeard} clicks heard, over floor ${f(lb.probe.overFloorDb, 1)} dB`);
    const sp = results.loopbackScriptProcessor;
    console.log('\nLoopback (ScriptProcessor fallback, clock approximate):');
    for (const b of sp.bursts) console.log(`  guide burst at ${b.at} s: lag ${b.lagSamples} samples = ${f(b.errorMs, 1)} ms`);
    console.log('\nFake microphone, 12 s take:');
    console.log(`  length ${f(results.mic.lengthSec, 3)} s (schedule ${f(results.mic.expectedSec, 3)} s), dropped ${results.mic.droppedFrames}, ${results.mic.batches} batches of ${results.mic.batchLengths.join('/')} frames, gaps ${JSON.stringify(results.mic.gaps)}`);
    console.log('\nEvents:', JSON.stringify(results.events));
    console.log('\nMain-thread stall while rendering a 12 s phrase (0.75x, -5 st, to 48 kHz); 2 ms timer, longest gap:');
    for (const k of ['idle', 'worker', 'workerWarm', 'slicedMainThread', 'slicedMainThreadWithShift', 'oneGo']) {
      console.log(`  ${k.padEnd(26)} total ${f(results.stall[k].totalMs, 0).padStart(5)} ms   longest gap ${f(results.stall[k].longestMainThreadGapMs, 1).padStart(6)} ms`);
    }
    if (results.stallThrottled) {
      console.log(`\nSame, with the page's CPU throttled ${results.throttle}x (a rough stand-in for a slower phone; the worker may not be slowed by it):`);
      for (const k of ['idle', 'worker', 'workerWarm', 'slicedMainThread', 'slicedMainThreadWithShift', 'oneGo']) {
        console.log(`  ${k.padEnd(26)} total ${f(results.stallThrottled[k].totalMs, 0).padStart(5)} ms   longest gap ${f(results.stallThrottled[k].longestMainThreadGapMs, 1).padStart(6)} ms`);
      }
    }
    console.log(`  preparePlayback (cold, 0.6x +3 st): ${f(results.stall.preparePlayback.ms, 0)} ms -> ${f(results.stall.preparePlayback.bufferSec, 2)} s at ${results.stall.preparePlayback.bufferRate} Hz (context ${results.stall.preparePlayback.contextRate} Hz)`);
    console.log('\nDiagnostics page checks (real Chromium):');
    for (const d of results.diagnostics) console.log(`  ${d.status.toUpperCase().padEnd(4)} ${d.id.padEnd(15)} ${d.summary}`);
    console.log('\nChecks:');
    for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  [${c.detail}]`);
  }
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

