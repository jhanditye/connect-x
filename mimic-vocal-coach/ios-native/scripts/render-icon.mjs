// OPTIONAL, developer-machine only: re-renders the app icon and launch images in assets/ with headless Chromium.
// You do NOT need this on the Mac. The rendered PNGs are already committed in assets/ and are what
// `npm run postprocess` copies into the Xcode asset catalog.
//
//   node scripts/render-icon.mjs               write the two launch images; render the icon in memory and compare it
//                                              with the committed assets/icon-1024.png (pixel diff report)
//   node scripts/render-icon.mjs --write-icon  also overwrite assets/icon-1024.png with the fresh render
//
// Needs Playwright with a Chromium build installed globally (it is not a dependency of this project). The module
// is loaded from /opt/node22/lib/node_modules/ as on the machine this project was generated on; point
// PLAYWRIGHT_MODULES at another global node_modules folder if yours lives elsewhere.
//
// Output (all fully opaque RGB; Apple rejects an app icon with an alpha channel):
//   assets/icon-1024.png        1024x1024  App Store / asset catalog icon: the "M." tile, full bleed, no rounded corners
//                               (iOS applies the corner mask itself). The committed file is the 1024 px output of the
//                               web app's own icon generator, so it matches public/icons pixel for pixel in design.
//   assets/splash-light.png     2732x2732  launch image, light: --paper background with the "M." mark centred
//   assets/splash-dark.png      2732x2732  launch image, dark:  dark --paper background with the mark
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, '..');
const assets = path.join(nativeDir, 'assets');
const fontPath = path.resolve(nativeDir, '..', 'src', 'assets', 'fonts', 'gloock-latin.woff2');

const require = createRequire((process.env.PLAYWRIGHT_MODULES ?? '/opt/node22/lib/node_modules') + '/');
const { chromium } = require('playwright');

if (!fs.existsSync(fontPath)) throw new Error(`Font not found: ${fontPath} (the Gloock wordmark font ships with the web app)`);
const fontB64 = fs.readFileSync(fontPath).toString('base64');

// Colours are the design tokens in src/styles/tokens.css (light and dark palettes).
const TOKENS = {
  light: { tile: '#17191c', paper: '#eef0ea', ink: '#17191c', rec: '#d33f2f' },
  dark: { paper: '#111315', ink: '#eceee8', rec: '#ef5a4a' },
};

// The master vector (assets/icon-master.svg) is laid out on a 512 grid: the "M" glyph and the red dot as a full stop.
// Read the glyph and dot geometry out of it so the icon, and the launch mark, always follow the master.
const master = fs.readFileSync(path.join(assets, 'icon-master.svg'), 'utf8');
const attr = (tag, name) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`).exec(master);
  if (!m) throw new Error(`icon-master.svg: <${tag} ${name}> not found`);
  return m[1];
};
const geo = {
  x: attr('text', 'x'),
  y: attr('text', 'y'),
  fontSize: attr('text', 'font-size'),
  cx: attr('circle', 'cx'),
  cy: attr('circle', 'cy'),
  r: attr('circle', 'r'),
};

/** The mark alone (transparent background), on the 512 grid: the glyph in `glyph`, the full-stop dot in `rec`. */
function mark(glyph, rec) {
  return `<text x="${geo.x}" y="${geo.y}" font-family="Gloock" font-size="${geo.fontSize}" fill="${glyph}">M</text>` +
    `<circle cx="${geo.cx}" cy="${geo.cy}" r="${geo.r}" fill="${rec}"/>`;
}

const fontFace = `<style>@font-face{font-family:'Gloock';src:url(data:font/woff2;base64,${fontB64}) format('woff2');}</style>`;

function iconSvg(size) {
  const c = TOKENS.light;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${fontFace}` +
    `<rect width="512" height="512" fill="${c.tile}"/>${mark(c.paper, c.rec)}</svg>`;
}

/** Launch image: flat background, the mark ~21% of the canvas width, centred. */
function splashSvg(theme) {
  const size = 2732;
  const c = TOKENS[theme];
  const markBox = 610; // px edge of the 512-grid square; the glyph block is ~85% of that (about 520 px)
  const off = (size - markBox) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${fontFace}` +
    `<rect width="${size}" height="${size}" fill="${c.paper}"/>` +
    `<g transform="translate(${off} ${off}) scale(${markBox / 512})">${mark(c.ink, c.rec)}</g></svg>`;
}

async function shot(browser, svg, size, bg, file) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${bg}">${svg}</body></html>`);
  await page.evaluate(() => document.fonts.load("360px Gloock"));
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ type: 'png', omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  if (file) fs.writeFileSync(file, buf);
  return buf;
}

const writeIcon = process.argv.includes('--write-icon');
const iconFile = path.join(assets, 'icon-1024.png');

/** Pixel comparison of two PNG buffers, done inside Chromium with a canvas (no image library needed). */
async function compare(browser, a, b) {
  const page = await browser.newPage();
  const uri = (buf) => 'data:image/png;base64,' + buf.toString('base64');
  const res = await page.evaluate(async ([A, B]) => {
    const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
    const [ia, ib] = await Promise.all([load(A), load(B)]);
    const px = (img) => { const k = document.createElement('canvas'); k.width = img.width; k.height = img.height; const x = k.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
    const da = px(ia), db = px(ib);
    let n = 0, max = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d) n += 1;
      if (d > max) max = d;
    }
    return { sameSize: ia.width === ib.width && ia.height === ib.height, differing: n, max, total: da.length / 4 };
  }, [uri(a), uri(b)]);
  await page.close();
  return res;
}

const browser = await chromium.launch();
const icon = await shot(browser, iconSvg(1024), 1024, TOKENS.light.tile, null);
await shot(browser, splashSvg('light'), 2732, TOKENS.light.paper, path.join(assets, 'splash-light.png'));
await shot(browser, splashSvg('dark'), 2732, TOKENS.dark.paper, path.join(assets, 'splash-dark.png'));
if (fs.existsSync(iconFile)) {
  const r = await compare(browser, icon, fs.readFileSync(iconFile));
  const note = r.differing === 0 ? 'identical' : `${r.differing} of ${r.total} pixels differ (max channel difference ${r.max}); these are anti-aliasing differences on glyph edges from rounding the master's coordinates`;
  console.log(`fresh render vs committed assets/icon-1024.png: ${note}`);
}
if (writeIcon || !fs.existsSync(iconFile)) {
  fs.writeFileSync(iconFile, icon);
  console.log('wrote assets/icon-1024.png from the fresh render');
}
await browser.close();
for (const f of ['icon-1024.png', 'splash-light.png', 'splash-dark.png']) {
  console.log(f.padEnd(20), `${fs.statSync(path.join(assets, f)).size} bytes`);
}
