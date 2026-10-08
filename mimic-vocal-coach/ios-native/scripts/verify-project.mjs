// Checks the native project without Xcode: structure, Info.plist, build settings, icons, launch images, and that the
// web bundle inside the app is complete. It runs on Linux and macOS (plain Node), and it is the same check used
// when this project was generated.
//
//   npm run verify              everything, including the web bundle copied into ios/App/App/public
//   npm run verify -- --no-bundle   skip the bundle checks (right after unzipping, before the first sync)
//
// What it proves is that the files are present and consistent. It does NOT prove the project compiles or runs: only
// Xcode can do that (README, "What is verified").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlist } from './lib/plist.mjs';
import { pngInfo } from './lib/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, '..');
const iosApp = path.join(nativeDir, 'ios', 'App');
const appDir = path.join(iosApp, 'App');
const catalog = path.join(appDir, 'Assets.xcassets');
const checkBundle = !process.argv.includes('--no-bundle');

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const exists = (...p) => fs.existsSync(path.join(...p));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const json = (...p) => JSON.parse(read(...p));
const rel = (p) => path.relative(nativeDir, p);

// ------------------------------------------------------------------ package + config
const pkg = json(nativeDir, 'package.json');
const versions = ['@capacitor/core', '@capacitor/ios', '@capacitor/cli'].map((n) => pkg.dependencies?.[n] ?? pkg.devDependencies?.[n]);
check('Capacitor core, ios and cli are pinned to one exact version', versions.every((v) => v && versions[0] === v && /^\d+\.\d+\.\d+$/.test(v)), versions.join(' / '));

const configSource = read(nativeDir, 'capacitor.config.ts');
const configValue = (key) => new RegExp(`^\\s*${key}:\\s*'([^']+)'`, 'm').exec(configSource)?.[1];
const appId = configValue('appId');
const appName = configValue('appName');
const webDir = configValue('webDir');
check('capacitor.config.ts has appId, appName and webDir', Boolean(appId && appName && webDir), `${appId} / ${appName} / ${webDir}`);
// Offline guarantee: a server.url would make the app load a remote site. Strip comments before looking.
const codeOnly = configSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('capacitor.config.ts has no server.url or server block (stays offline)', !/\bserver\s*:/.test(codeOnly) && !/\burl\s*:/.test(codeOnly));
if (exists(appDir, 'capacitor.config.json')) {
  const generated = json(appDir, 'capacitor.config.json');
  check('generated capacitor.config.json has no server.url', !generated.server?.url);
  check('generated capacitor.config.json matches appId and appName', generated.appId === appId && generated.appName === appName);
}

// ------------------------------------------------------------------ project structure
const required = [
  'ios/App/App.xcodeproj/project.pbxproj',
  'ios/App/App/Info.plist',
  'ios/App/App/AppDelegate.swift',
  'ios/App/App/SceneDelegate.swift',
  'ios/App/App/Base.lproj/Main.storyboard',
  'ios/App/App/Base.lproj/LaunchScreen.storyboard',
  'ios/App/App/Assets.xcassets/Contents.json',
  'ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json',
  'ios/App/App/Assets.xcassets/Splash.imageset/Contents.json',
  'ios/App/CapApp-SPM/Package.swift',
  'ios/App/CapApp-SPM/Sources/CapApp-SPM/CapApp-SPM.swift',
];
const missing = required.filter((f) => !exists(nativeDir, f));
check('native project files are present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${required.length} files`);
if (missing.includes('ios/App/App.xcodeproj/project.pbxproj') || missing.includes('ios/App/App/Info.plist')) {
  console.log('\nThe native project is missing. Generate it with: npx cap add ios');
  process.exit(1);
}

const spm = read(iosApp, 'CapApp-SPM', 'Package.swift');
const spmPin = /capacitor-swift-pm[^)]*exact:\s*"([^"]+)"/.exec(spm)?.[1];
check('Swift package pins the same Capacitor version as package.json', spmPin === versions[0], `Package.swift ${spmPin} / package.json ${versions[0]}`);

// ------------------------------------------------------------------ project.pbxproj
const pbx = read(iosApp, 'App.xcodeproj', 'project.pbxproj');
const targets = [...pbx.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([0-9.]+);/g)].map((m) => m[1]);
check('iOS deployment target is 16.4 in every configuration', targets.length >= 4 && targets.every((t) => t === '16.4'), targets.join(', '));
const bundleIds = [...pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]);
check('bundle identifier matches appId', bundleIds.length >= 2 && bundleIds.every((b) => b === appId), bundleIds.join(', '));
check('device family is iPhone and iPad', /TARGETED_DEVICE_FAMILY = "1,2";/.test(pbx));
check('app icon set is wired to the target', /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/.test(pbx));
check('Swift package product is linked', /productName = "CapApp-SPM";/.test(pbx));
// Every file the "App" group references must exist (public, capacitor.config.json and config.xml are generated by cap sync).
const generatedByCapSync = new Set(['public', 'capacitor.config.json', 'config.xml']);
const referenced = [...pbx.matchAll(/path = ("?)([^";]+)\1; sourceTree = "<group>"/g)].map((m) => m[2]).filter((p) => !['Assets.xcassets'].includes(p));
const baseFiles = [...pbx.matchAll(/name = Base; path = ([^;]+);/g)].map((m) => m[1]);
const dangling = [...referenced, ...baseFiles].filter((p) => !generatedByCapSync.has(p) && !p.endsWith('App.app') && !exists(appDir, p));
check('every source, storyboard and plist the Xcode project references exists', dangling.length === 0, dangling.join(', '));

// ------------------------------------------------------------------ Info.plist
const plist = parsePlist(read(appDir, 'Info.plist'));
const text = (k) => (typeof plist.get(k) === 'string' ? plist.get(k) : '');
check('Info.plist: display name is the app name', plist.get('CFBundleDisplayName') === appName, String(plist.get('CFBundleDisplayName')));
check('Info.plist: NSMicrophoneUsageDescription is a real sentence', text('NSMicrophoneUsageDescription').length >= 40, `${text('NSMicrophoneUsageDescription').length} chars`);
check('Info.plist: NSCameraUsageDescription is present', text('NSCameraUsageDescription').length >= 40);
check('Info.plist: UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace are true', plist.get('UIFileSharingEnabled') === true && plist.get('LSSupportsOpeningDocumentsInPlace') === true);
check('Info.plist: iPhone is portrait only', JSON.stringify(plist.get('UISupportedInterfaceOrientations')) === JSON.stringify(['UIInterfaceOrientationPortrait']));
const ipadOrientations = plist.get('UISupportedInterfaceOrientations~ipad') ?? [];
check('Info.plist: iPad supports all four orientations', ipadOrientations.length === 4 && new Set(ipadOrientations).size === 4);
check('Info.plist: status bar style set, controlled by the view controller', plist.get('UIStatusBarStyle') === 'UIStatusBarStyleDefault' && plist.get('UIViewControllerBasedStatusBarAppearance') === true);
check('Info.plist: arm64 device requirement (not armv7)', JSON.stringify(plist.get('UIRequiredDeviceCapabilities')) === JSON.stringify(['arm64']));
check('Info.plist: launch screen and main storyboard are set', plist.get('UILaunchStoryboardName') === 'LaunchScreen' && plist.get('UIMainStoryboardFile') === 'Main');
check('Info.plist: no background modes (nothing keeps the mic running behind other apps)', !plist.has('UIBackgroundModes'));
check('Info.plist: no ATS exception (all traffic must be HTTPS)', !plist.has('NSAppTransportSecurity'));

// ------------------------------------------------------------------ icon and launch images
const icon = pngInfo(path.join(catalog, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
check('app icon is 1024x1024', icon.width === 1024 && icon.height === 1024, `${icon.width}x${icon.height}`);
check('app icon has no alpha channel (Apple requirement)', !icon.hasAlpha, icon.colorName);
const iconContents = json(catalog, 'AppIcon.appiconset', 'Contents.json');
check('AppIcon Contents.json points at the icon file', iconContents.images?.some((i) => i.filename === 'AppIcon-512@2x.png' && i.size === '1024x1024'));

const splashContents = json(catalog, 'Splash.imageset', 'Contents.json');
const splashFiles = splashContents.images.map((i) => i.filename);
const splashMissing = splashFiles.filter((f) => !exists(catalog, 'Splash.imageset', f));
check('launch image files referenced by Contents.json exist', splashMissing.length === 0, `${splashFiles.length} entries`);
const dark = splashContents.images.filter((i) => i.appearances?.some((a) => a.appearance === 'luminosity' && a.value === 'dark'));
check('launch image has light and dark variants (3 scales each)', dark.length === 3 && splashContents.images.length === 6);
const splashOk = splashFiles.every((f) => {
  const p = pngInfo(path.join(catalog, 'Splash.imageset', f));
  return p.width === 2732 && p.height === 2732 && !p.hasAlpha;
});
check('launch images are 2732x2732 and opaque', splashOk);
const lightImg = splashContents.images.find((i) => !i.appearances)?.filename;
const darkImg = dark[0]?.filename;
check('light and dark launch images differ', lightImg && darkImg && Buffer.compare(fs.readFileSync(path.join(catalog, 'Splash.imageset', lightImg)), fs.readFileSync(path.join(catalog, 'Splash.imageset', darkImg))) !== 0);

// ------------------------------------------------------------------ web bundle inside the app
if (checkBundle) {
  const pub = path.join(appDir, 'public');
  const www = path.join(nativeDir, webDir ?? 'www');
  if (!fs.existsSync(path.join(pub, 'index.html'))) {
    check('web bundle: ios/App/App/public/index.html exists (run `npm run prepare:ios`)', false);
  } else {
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)(?:[?#][^"]*)?"/g)].map((m) => m[1]).filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u));
    const gone = refs.filter((u) => !fs.existsSync(path.join(pub, u.replace(/^\.\//, ''))));
    check('web bundle: index.html and every file it references are inside the app', gone.length === 0, `${refs.length} references${gone.length ? `, missing: ${gone.join(', ')}` : ''}`);
    check('web bundle: no root-absolute URLs in index.html', !refs.some((u) => u.startsWith('/')));
    check('web bundle: no service worker shipped (cannot run in WKWebView)', !fs.existsSync(path.join(pub, 'sw.js')));
    const entry = refs.find((u) => /\.js$/.test(u));
    const entryPath = entry ? path.join(pub, entry.replace(/^\.\//, '')) : '';
    const js = entryPath && fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : '';
    check('web bundle: main script is present and non-trivial', js.length > 100_000, `${(js.length / 1024).toFixed(0)} kB`);
    const list = (dir) => {
      const out = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (!['cordova.js', 'cordova_plugins.js'].includes(e.name)) out.push(path.relative(dir, p));
        }
      })(dir);
      return out.sort();
    };
    if (fs.existsSync(www)) {
      const a = list(www);
      const b = list(pub);
      check('web bundle: app copy equals www (cap sync is up to date)', JSON.stringify(a) === JSON.stringify(b), `${a.length} vs ${b.length} files`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
