# Mimic on iPhone: the native app (local, offline)

This folder wraps the Mimic web app in a real iPhone app using [Capacitor](https://capacitorjs.com) 8.5.3. The
web build is copied **into the app**, so Mimic opens with no server, no hosting, no GitHub and no account, and
works in airplane mode. You build it yourself on a Mac with Xcode and install it on your own iPhone.

Why bother, when Mimic also runs as a Home Screen web app? Inside the app the web view should count as a secure
context (which the microphone needs) with a proper microphone permission (one iOS prompt, remembered in Settings),
files come in through the system file picker, and the app's storage belongs to the app instead of Safari's website
data. These are the reasons for the design; none of them has been seen working on a device yet.

## Read this first: it has never been run

**This project was generated and checked on Linux. It has never been opened in Xcode, never compiled, and never
run on an iPhone or in the Simulator, because there was no Mac.** The project files come from Capacitor's own
generator (not hand-written) and the checks below prove the files are present and consistent, but the first
Xcode build is the first real test. If it fails, the troubleshooting section at the end covers the likely causes.
The section "What is verified and what is not" lists exactly what was and was not tested.

## What you need

| Item | Detail |
|---|---|
| A Mac with **Xcode 26 or newer** | Free from the Mac App Store. Open it once, accept the licence, and let it install the iOS platform when it offers. Your Xcode must also be new enough for your iPhone's iOS version (an iPhone on iOS 27 needs Xcode 27). Capacitor 8.5.3 tests itself against an iOS 26.0.1 simulator, which is where "26" comes from. |
| **Node 22 or newer** | `node -v` should print v22 or higher (Capacitor 8's command line requires it). Install from nodejs.org if needed. |
| An iPhone on **iOS 16.4 or newer** | The web app uses features that arrive in Safari 16.4. The Xcode project is set to 16.4 so it will not install on anything older. |
| A cable, and an **Apple ID** | A free Apple ID is enough. |
| Internet **on the Mac, once** | `npm install` downloads packages, and Xcode downloads the Capacitor Swift package from GitHub (`ionic-team/capacitor-swift-pm`) the first time it opens the project. After that, building and the app itself need no network. CocoaPods is **not** needed (the project uses Swift Package Manager). |

## Steps (on the Mac)

The folder `ios-native/` belongs inside the web project, next to `package.json` and `src/`, as it is in the repository:
`mimic-vocal-coach/ios-native/`. (Only have a built site, such as `mimic-pwa.zip`, and not the source? See
"Without the web project" below.)

1. Open Terminal and go to this folder:
   ```bash
   cd path/to/mimic-vocal-coach/ios-native
   ```
2. Install the packages, once:
   ```bash
   npm install
   npm --prefix .. install
   ```
   The first installs Capacitor (this folder). The second installs the web app's own dependencies one level up.
3. Build the web app, copy it into the iOS project, and open Xcode:
   ```bash
   npm run ios
   ```
   That is shorthand for `npm run build:web`, then `npx cap sync ios` plus the project tweaks (`npm run sync`),
   then `npx cap open ios`. You can run the three pieces separately if you like.
4. **Wait for Xcode to finish "Resolving Package Graph"** (progress in the top bar; about a minute, needs internet).
5. Pick your Apple ID as the signing team:
   1. In the left sidebar click the blue **App** project, then under TARGETS choose **App**.
   2. Open the **Signing & Capabilities** tab and tick **Automatically manage signing**.
   3. Under **Team**, choose your Apple ID ("Your Name (Personal Team)"). If it is not listed: Xcode menu,
      Settings, Accounts, the **+** button, Apple ID, sign in, then come back.
   4. If Xcode says the bundle identifier is unavailable, make it unique, for example
      `app.mimic.vocalcoach.yourname`. Change it in `capacitor.config.ts` (`appId`) and run `npm run postprocess`
      (it copies the id into the Xcode project), or just type it into the Bundle Identifier field in Xcode.
6. Connect the iPhone with the cable, unlock it, and tap **Trust** on "Trust This Computer?". In Xcode pick the
   phone in the device menu at the top (next to the scheme "App").
7. Turn on **Developer Mode** on the phone: Settings, Privacy & Security, Developer Mode, On (it restarts; this
   switch only appears after the phone has been connected to Xcode once).
8. Press **Run** (the triangle, or Command-R). Xcode builds, installs and launches Mimic.
9. First launch on a free account: iOS says "Untrusted Developer". On the phone go to Settings, General,
   VPN & Device Management, tap your Apple ID under "Developer App", **Trust**, then open Mimic again.
10. Tap Record in Mimic and **Allow** the microphone. If you tapped Don't Allow, switch it on in Settings, Mimic,
    Microphone.

## The 7-day limit, and the paid alternative

An app signed with a **free Apple ID expires after 7 days**: after that it will not open (the icon stays; iOS says
the app is no longer available or cannot be verified). To refresh it, connect the phone and press Run again in
Xcode; that re-signs it for another 7 days. Running again over the existing install is an update, so with the same
bundle identifier and team the app's data should stay (expected behaviour, not tested here); **deleting the app
deletes its data**. Free accounts are also limited in how many apps and app identifiers they may have at once, so
if Xcode complains about a limit, delete an old test app or wait.

The paid **Apple Developer Program** (about US$99 a year) signs for a year and allows TestFlight. It is not needed
to use Mimic, only to avoid the weekly re-run.

## Updating the web app inside the native app

The app contains a copy of the web files from the moment you built it; it does not update itself and has no
service worker. After the web app changes:

```bash
cd path/to/mimic-vocal-coach/ios-native
npm run prepare:ios        # build the web app and copy it into the iOS project
```

then press Run in Xcode (or `npm run ios` to do both and reopen Xcode). Use the same bundle identifier and team so
the update installs over the old one and keeps your clips.

### Without the web project (only a built site)

Unzip the built site (for example `mimic-pwa.zip`, the folder containing `index.html`), then:

```bash
npm install
npm run build:web -- --from /path/to/unzipped/site
npm run sync
npm run open
```

`--from` copies the finished site instead of building. Everything else is the same.

### If this folder came with the web bundle already inside

A zip made with `npm run zip -- --with-web` also contains the web app (`ios/App/App/public`). Then the Xcode project
is complete as it is: open `ios/App/App.xcodeproj` and start at step 4; Node is only needed to update later.
A plain `npm run zip` leaves that folder out, and `npm run sync` (or `npm run ios`) is what puts it there.

## What is in this folder

```
ios-native/
  package.json              Capacitor 8.5.3 (core, ios, cli) pinned exactly, plus the scripts below
  capacitor.config.ts       appId app.mimic.vocalcoach, name "Mimic", webDir www, no server.url (offline)
  assets/                   icon-1024.png, splash-light.png, splash-dark.png, icon-master.svg (the design sources)
  scripts/
    build-web.mjs           npm run build:web      builds ../ into www/ (or copies a built site with --from)
    postprocess-ios.mjs     npm run postprocess    applies the Info.plist, build setting and asset changes below
    verify-project.mjs      npm run verify         checks structure, plist, icons and web bundle (no Xcode needed)
    render-icon.mjs         npm run icons          optional: re-renders the launch images/icon with headless Chromium
    make-zip.mjs            npm run zip            zips the project without node_modules or build outputs
    lib/                    a small plist reader/writer and PNG header reader (no dependencies)
  ios/App/                  the Xcode project (App.xcodeproj), Swift sources, storyboards, asset catalog
    App/Info.plist          settings listed below
    App/public/             generated by `cap sync`: the web app as shipped inside the app
    CapApp-SPM/             Swift Package that pulls in Capacitor (managed by Capacitor, do not edit)
  www/                      generated by `npm run build:web` (the web build, minus sw.js)
```

`npm run build:web` writes to `www/` and never to `../dist`, so the normal web build is untouched. It removes `sw.js`
from the copy that goes into the app: iOS only allows service workers in a web view for "app-bound domains", so it
could never run, and a stale one must not be able to pin an old version.

### What differs from Capacitor's template

The project-file changes are applied by `npm run postprocess` (also run by `npm run sync`; safe to repeat). The config row is plain `capacitor.config.ts`.

| Where | Setting | Why |
|---|---|---|
| Info.plist | `NSMicrophoneUsageDescription`: "Mimic listens through the microphone while you record a take... never uploaded." | Required. Without it iOS terminates the app the first time the web page opens the microphone. |
| Info.plist | `NSCameraUsageDescription` (explains the video import case) | Safety net. If the system picker offers "Take Photo or Video" and the app has no camera description, iOS terminates the app when it is tapped. Whether the picker offers that option depends on which file types the web app accepts; not tested. |
| Info.plist | `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` = true | A **Mimic** folder should appear in the Files app under On My iPhone, so clips can be put there (AirDrop, Files) and picked with the import button. Mimic does not write to that folder itself; its data lives in the web view's storage. |
| Info.plist | `UISupportedInterfaceOrientations`: portrait only. `~ipad`: all four. | Portrait on iPhone as designed; iPad multitasking needs all four. |
| Info.plist | `UIStatusBarStyle` = default, `UIViewControllerBasedStatusBarAppearance` = true | Status bar text turns dark or light with the system appearance. |
| Info.plist | `CFBundleDisplayName` = Mimic; `UIRequiredDeviceCapabilities` = arm64 (template said armv7); `ITSAppUsesNonExemptEncryption` = false | Home Screen name; correct architecture; only iOS's built-in HTTPS is used, so no export-compliance question. |
| project.pbxproj | iOS deployment target 16.4 (template: 15.0); bundle identifier follows `appId` | The web bundle needs Safari 16.4 features. |
| capacitor.config.ts | pinch-zoom allowed, link previews off, `contentInset: 'never'`, no `server.url` | Zoom matches the web app (it avoids `user-scalable=no` for accessibility). Capacitor's default would lock zoom. |
| Asset catalog | `AppIcon`: one 1024 px opaque icon (the dark "M." tile). `Splash`: light and dark launch images. | Xcode derives every icon size from the 1024 px image. The launch image is the same mark on the app's paper colour (light) or dark colour. |

Not touched: Swift sources, storyboards, `Package.swift`. No background modes are enabled, so recording stops when the
app leaves the screen. There is no App Transport Security exception, so all network traffic must be HTTPS.

## How it should behave on the phone (expected, not tested)

**Microphone.** The web view is `capacitor://localhost`. Capacitor's own code answers WebKit's microphone request with
"granted" (`requestMediaCapturePermissionFor` in `WebViewDelegationHandler.swift`), so the only prompt is iOS's own,
remembered under Settings, Mimic. That is the main gain over Safari, which asks per site.

**Audio session and the silent switch.** WebKit manages the `AVAudioSession` itself, and this project does not set one
(`AppDelegate.swift` is unchanged), because WebKit re-sets the category whenever media starts, so a category chosen at
launch would probably be overridden.
- While the microphone is open WebKit uses category PlayAndRecord (mode VideoChat, with Bluetooth, A2DP, AirPlay and
  default-to-speaker options; this comes from reading WebKit's source during the iPhone research, and was not
  observed on a device). PlayAndRecord is not silenced by the ring/silent switch, so the guide you play while singing
  should be audible.
- Playback with no microphone (the practice tones and pattern player) is Web Audio only, which WebKit treats as
  "ambient": **it is muted by the silent switch**, as in Safari. The web app's `tones.ts` asks for
  `navigator.audioSession.type = 'playback'` to avoid that. That API exists in Safari 16.4+; whether it is present in a
  Capacitor web view was not tested. If tones are silent with the switch on, that is the first thing to check.
- AirPods or other Bluetooth headsets can take over the input and drop it to a telephone-quality sample rate, exactly as
  in Safari. The app's microphone picker (Settings) applies here too.
- Capacitor sets `mediaTypesRequiringUserActionForPlayback = []`, so audio may start without a tap here. The web app
  still resumes its audio context on a tap, which does no harm.
- If you want to experiment with a native category anyway, add this in `AppDelegate.swift` inside
  `didFinishLaunchingWithOptions` (not applied here, untested, and WebKit may override it):
  ```swift
  import AVFoundation
  try? AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
  ```

**Importing audio.** The import button is a normal web file input, which iOS shows as the system sheet: Files (iCloud
Drive, On My iPhone including the Mimic folder, AirDrop downloads) and, when video types are accepted, the Photo
Library. Voice Memos are not visible to the picker: Share the memo, Save to Files, then pick it. Tracks from the
Music app's library are not reachable by any web file picker; they must be files.

**Storage.** IndexedDB and localStorage live in the app's own web view data store, separate from Safari's and from a
Home Screen web app's. The 7-day eviction that applies to Safari websites is designed around Safari and Home Screen
web apps, and the expectation is that it does not apply to an app's own web view; I could not verify that without a
device, so treat "kept indefinitely" as expected, not proven. Deleting the app deletes the data.

## Known limits

1. **Never compiled or run** (see the top). The first build may show errors I could not see.
2. **Dark mode flash.** `backgroundColor` in `capacitor.config.ts` is the light paper colour (`#eef0ea`), as requested.
   Capacitor accepts only one colour, so in dark mode the web view shows light paper for a fraction of a second between
   the (dark) launch image and the first painted page. Delete the `backgroundColor` line to use the system's adaptive
   background instead (white in light mode, black in dark mode), then run `npm run sync`.
3. **Status bar text follows the iPhone's appearance, not Mimic's own theme switch.** If Mimic is forced to Light while
   the phone is in Dark mode, the clock and battery are drawn in light text on the light paper top bar. The fix is the
   Capacitor status-bar plugin plus a few lines in the web app (see below); it is not included.
4. **The web app does not know it is inside an app yet.** It looks for "Home Screen app" signals (`navigator.standalone`)
   that a native web view does not have, so until the web app is updated (list below) it may show the "Install on
   iPhone" card, report "Works offline: Not available", and offer an update banner flow that cannot happen here.
5. **Saving or exporting files out of the app** (download a take as WAV, export the library) relies on the share sheet
   (`navigator.share({ files })`). A plain `<a download>` does nothing inside a web view. I believe WebKit's share
   sheet works in a web view but did not test it. If it does not, the fix is the Capacitor Filesystem and Share
   plugins plus a small change in the web app.
6. **Layout on a real notch** is unverified. `contentInset` is `never`: the page draws edge to edge and uses
   `env(safe-area-inset-*)` (its CSS already does, checked in Chromium emulation only). If the top bar sits under
   the clock, set `contentInset: 'always'` in `capacitor.config.ts` and run `npm run sync`.
7. **iPad** runs the same layout as a native iPad app (all orientations); only iPhone portrait is the design target.
8. **No background recording.** A take stops when you leave the app, lock the screen, or take a call.
9. **The optional AI coach** calls `api.anthropic.com` from the origin `capacitor://localhost`; whether that origin is
   accepted by the API's cross-origin rules was not tested. Everything else works with no network.
10. `npm audit` reports 3 moderate advisories (the `uuid` package, reached through Capacitor's command-line tool). They
    are build-time only and are not in the app. `npm audit fix --force` would downgrade the Capacitor CLI; leave it.

### Changes recommended in the web app (not made here)

These live outside this folder. Inside the app `window.Capacitor?.isNativePlatform?.()` is true.
- `src/pwa/platform.ts`: make `isStandalone()` true when running inside Capacitor, and skip the install card.
- `src/pwa/register.ts`: skip service-worker registration inside Capacitor (it already no-ops when
  `navigator.serviceWorker` is missing, which is expected in a web view; an explicit check is clearer) and hide the
  update banner and "Check for updates" there.
- Settings, Offline and storage: say "Built into the app" instead of "Works offline: Not available".
- Optional: set the status-bar style from the theme with `@capacitor/status-bar` (run `npm install @capacitor/status-bar`
  here and in the web app, then `npm run sync`), and use `@capacitor/share` plus `@capacitor/filesystem` if the share
  sheet in item 5 does not work.

## What is verified and what is not

**Verified on Linux (this machine: Node 22.22, npm 10.9):**
- `npm install` of Capacitor 8.5.3 (core, ios, cli) and TypeScript; versions come from `npm view` (latest on the day).
- The web app type-checks and builds with its own `tsc -b` plus `vite build` into `www/`; `sw.js` is removed; every file
  `index.html` references is present and none is root-absolute (with the web source as it was at the time; the web app
  was still being changed by other work, so rebuild before relying on it). `../dist` is never touched.
- `npx cap add ios` and `npx cap sync ios` run to completion on Linux with Swift Package Manager (no CocoaPods), so the
  Xcode project is Capacitor's own output, not hand-written. Running the whole sync flow twice changes nothing the
  second time.
- Info.plist parses with Python's `plistlib` and with the project's own reader, and contains the keys listed above.
  `project.pbxproj` has deployment target 16.4 in all four places and the bundle id `app.mimic.vocalcoach`.
- The app icon is 1024 by 1024, RGB with no alpha channel; the launch images are 2732 by 2732, opaque, light and dark.
  The icon is the web app's icon generator output; a fresh Chromium render of the master SVG differs in 674 of 1,048,576
  pixels (anti-aliasing on glyph edges only).
- `npm run verify` runs 36 checks and passes; on a deliberately broken copy it fails the right checks.
- The zip unpacks and passes `npm run verify -- --no-bundle` (31 checks). From the unpacked copy, `npm install`,
  `npm run build:web -- --from <built site>`, `npm run sync` and `npm run verify` (36 checks) all succeed, so the Mac
  steps work up to the point where Xcode takes over. The default `npm run build:web` (building the web project one
  folder up) was run in place, inside the real web project. `npm run open` needs macOS and was not run.

**NOT verified (needs a Mac and an iPhone):**
- Opening in Xcode, Swift package resolution, compiling, code signing, installing, launching. The asset catalog (including
  the dark launch image entries) and storyboards have not been through Xcode's compiler.
- Everything at runtime: the microphone prompt and `getUserMedia` in the web view (including that `capacitor://localhost`
  counts as a secure context, which Capacitor apps rely on), the file picker and which sources it offers, IndexedDB
  persistence and the eviction question, the silent switch and AVAudioSession behaviour, AirPods, safe areas, the
  status bar, the launch screen's look, the share sheet, performance and memory on a phone.
- The minimum Xcode version: "26" is inferred from Capacitor's own test configuration, not from a statement by Apple
  or Capacitor.

## Troubleshooting

| Symptom | Try |
|---|---|
| "Signing for App requires a development team" | Step 5: choose your Apple ID under Team. |
| "Failed to register bundle identifier" | Make the identifier unique (step 5.4), or you have hit the free account's weekly limit. |
| Package errors, "No such module Capacitor", "Missing package product" | Check the Mac is online, then File, Packages, Reset Package Caches, then File, Packages, Resolve Package Versions. |
| "Build input file cannot be found: .../public" | Run `npm run sync` (it creates `ios/App/App/public`). |
| `build:web` says dependencies are not installed | `npm --prefix .. install`. |
| `npm run ios` fails in `tsc -b` | The web app has a type error; fix it, or `npm run build:web -- --no-typecheck`. |
| Phone not listed, or "Developer Mode disabled" | Unlock the phone, tap Trust, and turn on Developer Mode (step 7). |
| App will not open after a week | The free-account signing expired: connect the phone and press Run again. |
| White or blank screen | Use Safari's Web Inspector. On the Mac: Safari, Settings, Advanced, tick "Show features for web developers". On the iPhone: Settings, Safari (under Apps on newer iOS), Advanced, Web Inspector on. Then in Mac Safari: Develop, your iPhone, Mimic. Builds made by Xcode's Run button are Debug builds and are inspectable; Release builds are not. |
| Microphone does nothing | Settings, Mimic, Microphone must be on. If it was denied once, the app will not ask again. |
| Top bar hidden under the clock | `contentInset: 'always'` in `capacitor.config.ts`, then `npm run sync`. |

If a build fails, the first red error line in Xcode's issue navigator is the one that matters.

## Maintainer notes

- Check the project any time: `npm run verify`. After the first unzip, before any sync: `npm run verify -- --no-bundle`.
- Re-create the native project from scratch: delete `ios/`, run `npx cap add ios`, then `npm run sync` (which re-applies every
  change in the table above).
- Re-render the icon and launch images: `npm run icons` (needs a global Playwright with Chromium; see the top of
  `scripts/render-icon.mjs`). Add `-- --write-icon` to overwrite `assets/icon-1024.png` with the fresh render.
- Zip for a Mac: `npm run zip` (without the web bundle) or `npm run prepare:ios && npm run zip -- --with-web`.
- Upgrading Capacitor: change the three exact versions in `package.json`, `npm install`, `npm run sync`, `npm run verify`.
