import type { CapacitorConfig } from '@capacitor/cli';

// Mimic runs entirely on the phone: the built web app is copied into the app bundle and served to the
// WKWebView from capacitor://localhost. There is deliberately NO `server.url` (that would load a remote
// site and need a network) and no `server.allowNavigation`, so the app cannot navigate away from itself.
const config: CapacitorConfig = {
  // Reverse-DNS bundle identifier. Xcode needs it to be unique per Apple ID, so if signing complains that
  // it is already taken, change it here AND in Xcode (App target > Signing & Capabilities > Bundle Identifier),
  // for example app.mimic.vocalcoach.yourname.
  appId: 'app.mimic.vocalcoach',
  appName: 'Mimic',

  // Where `npm run build:web` puts the Vite build (kept inside ios-native/ so it never touches ../dist).
  webDir: 'www',

  // Shown while the WebView loads and behind any area the page does not paint. This is --paper from
  // src/styles/tokens.css (light theme). See README, "Known limits", for the dark-mode flash this causes.
  backgroundColor: '#eef0ea',

  ios: {
    // 'never': the page draws edge to edge and handles the notch, Dynamic Island and home indicator itself
    // with env(safe-area-inset-*) (index.html has viewport-fit=cover; app.css pads the top bar and tab bar).
    // If the top bar ever sits under the clock on a real phone, set this to 'always' and run `npm run sync`.
    contentInset: 'never',
    // Pinch-zoom stays available, as in the web app (index.html deliberately has no maximum-scale or user-scalable=no:
    // blocking zoom is an accessibility failure). Capacitor's default is to lock zoom, so this is set explicitly.
    zoomEnabled: true,
    // No link-preview popups on long-press.
    allowsLinkPreview: false,
    // Safari Web Inspector: Capacitor leaves it on for Debug builds (what Xcode's Run makes) and off for Release, so
    // `webContentsDebuggingEnabled` is deliberately not set here. Setting it to false would also block Debug builds.
  },
};

export default config;
