// Applies Mimic's settings to the native project that `npx cap add ios` generated. Safe to run any number of times
// (npm run sync does it after every `cap sync`), and it only touches what is listed here:
//
//   1. ios/App/App/Info.plist
//        - microphone usage description (the app crashes the moment it opens the mic without one)
//        - camera usage description (safety net, see the comment below)
//        - UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace (a "Mimic" folder in Files > On My iPhone)
//        - portrait only on iPhone, every orientation on iPad
//        - status bar style, display name, arm64 device requirement, export-compliance flag
//   2. ios/App/App.xcodeproj/project.pbxproj
//        - iOS deployment target 16.4 (the web bundle needs Safari 16.4 features, see README)
//        - bundle identifier follows `appId` in capacitor.config.ts
//   3. ios/App/App/Assets.xcassets
//        - AppIcon: assets/icon-1024.png (the single 1024 px icon; Xcode derives every other size)
//        - Splash: assets/splash-light.png and assets/splash-dark.png (light and dark launch screens)
//
// It does not touch Swift sources, storyboards or Package.swift, and it needs no Mac: plain Node, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlist, serializePlist } from './lib/plist.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const nativeDir = path.resolve(here, '..');
const appDir = path.join(nativeDir, 'ios', 'App', 'App');
const pbxPath = path.join(nativeDir, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const assetsDir = path.join(nativeDir, 'assets');
const catalog = path.join(appDir, 'Assets.xcassets');

/** Keep in step with the README: the web app uses regex lookbehind, color-mix() and overflow: clip (all Safari 16.4+). */
const IOS_DEPLOYMENT_TARGET = '16.4';

if (!fs.existsSync(path.join(appDir, 'Info.plist')) || !fs.existsSync(pbxPath)) {
  console.error('postprocess-ios: ios/App is missing. Generate the native project first:\n\n    npx cap add ios\n');
  process.exit(1);
}

const changes = [];
const note = (what) => changes.push(what);

// ---------------------------------------------------------------- capacitor.config.ts (appId, appName)
const configSource = fs.readFileSync(path.join(nativeDir, 'capacitor.config.ts'), 'utf8');
const configValue = (key) => new RegExp(`^\\s*${key}:\\s*'([^']+)'`, 'm').exec(configSource)?.[1];
const appId = configValue('appId');
const appName = configValue('appName');
if (!appId || !appName) {
  console.error("postprocess-ios: could not read appId and appName from capacitor.config.ts (they must be single-quoted strings).");
  process.exit(1);
}

// ---------------------------------------------------------------- Info.plist
const plistPath = path.join(appDir, 'Info.plist');
const plist = parsePlist(fs.readFileSync(plistPath, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function setKey(key, value) {
  if (!same(plist.get(key), value) || !plist.has(key)) {
    plist.set(key, value);
    note(`Info.plist ${key}`);
  }
}

setKey('CFBundleDisplayName', appName);

// Required: without it iOS terminates the app the first time getUserMedia asks for the microphone.
setKey(
  'NSMicrophoneUsageDescription',
  'Mimic listens through the microphone while you record a take, so it can measure your pitch, tone and timing. The sound is analysed on this iPhone and is never uploaded.',
);
// Safety net, not a feature. The import picker is the system one (<input type="file">). If it offers "Take Photo or Video"
// (it can when video types are accepted, for sound from a phone video) and the app has no camera description, iOS
// terminates the app when that is tapped. With the text it just asks once.
setKey(
  'NSCameraUsageDescription',
  'Only used if you pick "Take Photo or Video" while importing a clip, so Mimic can read the sound from the video. The camera is never used for anything else and nothing is uploaded.',
);

// Files app: puts a "Mimic" folder under On My iPhone, so clips can be dropped there (AirDrop, Files) and then picked
// with the import button. Mimic itself keeps its data in the web view's storage, not in this folder.
setKey('UIFileSharingEnabled', true);
setKey('LSSupportsOpeningDocumentsInPlace', true);

// Orientation: portrait on iPhone, everything on iPad (iPad multitasking needs all four).
setKey('UISupportedInterfaceOrientations', ['UIInterfaceOrientationPortrait']);
setKey('UISupportedInterfaceOrientations~ipad', [
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
]);

// Status bar: the view controller decides (true), and its default style flips between dark and light text with the
// system appearance. UIStatusBarStyle covers the launch phase. The text never follows the app's own theme switch
// unless the status-bar plugin is added (README, "Known limits").
setKey('UIViewControllerBasedStatusBarAppearance', true);
setKey('UIStatusBarStyle', 'UIStatusBarStyleDefault');
setKey('UIStatusBarHidden', false);

// The template says armv7, a 32-bit architecture no iOS 16 device has. arm64 is what every supported iPhone and iPad is.
setKey('UIRequiredDeviceCapabilities', ['arm64']);

// Mimic only uses the encryption built into iOS (HTTPS for the optional AI coach), which is exempt, so Xcode and
// TestFlight stop asking the export-compliance question.
setKey('ITSAppUsesNonExemptEncryption', false);

const plistText = serializePlist(plist);
if (plistText !== fs.readFileSync(plistPath, 'utf8')) fs.writeFileSync(plistPath, plistText);

// ---------------------------------------------------------------- project.pbxproj
let pbx = fs.readFileSync(pbxPath, 'utf8');
const pbxBefore = pbx;
pbx = pbx.replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET};`);
if (pbx !== pbxBefore) note(`project.pbxproj IPHONEOS_DEPLOYMENT_TARGET = ${IOS_DEPLOYMENT_TARGET}`);
const pbxMid = pbx;
pbx = pbx.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`);
if (pbx !== pbxMid) note(`project.pbxproj PRODUCT_BUNDLE_IDENTIFIER = ${appId}`);
if (pbx !== pbxBefore) fs.writeFileSync(pbxPath, pbx);

// ---------------------------------------------------------------- asset catalog
function copyIfDifferent(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`postprocess-ios: ${path.relative(nativeDir, src)} is missing.`);
    process.exit(1);
  }
  const data = fs.readFileSync(src);
  if (fs.existsSync(dest) && Buffer.compare(data, fs.readFileSync(dest)) === 0) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  note(`Assets.xcassets/${path.relative(catalog, dest)}`);
}
function writeJsonIfDifferent(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text);
  note(`Assets.xcassets/${path.relative(catalog, file)}`);
}

// App icon: one 1024 px image, universal; Xcode 14+ generates every size from it. Must be opaque, which the verify
// script checks. File name kept as Capacitor's template names it.
const iconSet = path.join(catalog, 'AppIcon.appiconset');
copyIfDifferent(path.join(assetsDir, 'icon-1024.png'), path.join(iconSet, 'AppIcon-512@2x.png'));
writeJsonIfDifferent(path.join(iconSet, 'Contents.json'), {
  images: [{ filename: 'AppIcon-512@2x.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 },
});

// Launch image: the storyboard shows the "Splash" image aspect-fill, so it is one square image with the mark in the
// middle. Light and dark variants; the template names (without "-dark") are the light ones.
const splashSet = path.join(catalog, 'Splash.imageset');
const lightNames = { '1x': 'splash-2732x2732-2.png', '2x': 'splash-2732x2732-1.png', '3x': 'splash-2732x2732.png' };
const darkNames = { '1x': 'splash-dark-2732x2732-2.png', '2x': 'splash-dark-2732x2732-1.png', '3x': 'splash-dark-2732x2732.png' };
for (const name of Object.values(lightNames)) copyIfDifferent(path.join(assetsDir, 'splash-light.png'), path.join(splashSet, name));
for (const name of Object.values(darkNames)) copyIfDifferent(path.join(assetsDir, 'splash-dark.png'), path.join(splashSet, name));
writeJsonIfDifferent(path.join(splashSet, 'Contents.json'), {
  images: [
    ...Object.entries(lightNames).map(([scale, filename]) => ({ idiom: 'universal', filename, scale })),
    ...Object.entries(darkNames).map(([scale, filename]) => ({
      appearances: [{ appearance: 'luminosity', value: 'dark' }],
      idiom: 'universal',
      filename,
      scale,
    })),
  ],
  info: { author: 'xcode', version: 1 },
});

// ---------------------------------------------------------------- report
if (changes.length === 0) console.log('postprocess-ios: already up to date, nothing to change.');
else {
  console.log(`postprocess-ios: updated ${changes.length} item${changes.length === 1 ? '' : 's'}:`);
  for (const c of changes) console.log(`  - ${c}`);
}
