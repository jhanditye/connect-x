// Words that depend on the device. The app was written for an iPhone first; on a Mac (or another desktop) the same steps read
// differently: there is no Home Screen, no Files app, no phone held to the mouth. Pure functions over a PlatformKind (or a
// PlatformEnv), so a test can inject the platform and a component only has to call platformKind() once.
//
// 'ios' and 'other' (an Android phone, an embedded view, a test DOM, an unreadable user agent) get exactly the phone wording the app
// has always had; only a positively recognised Mac or desktop gets the computer wording. Nothing here claims to have been run on a
// Mac: where a menu path or a browser behaviour could not be checked it says "should".

import { desktopBrowser, isDesktopKind, platformKind, readEnv, type DesktopBrowser, type PlatformEnv, type PlatformKind } from './platform';

/** True when Mimic is being served from this computer itself (the Mac download): files then come from the Mimic folder, not the internet. */
export function onLocalServer(): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location?.hostname ?? '');
  } catch {
    return false;
  }
}

/** True on a GitHub Pages address, where every project of one owner shares the browser storage of one origin. */
export function onGithubPages(): boolean {
  try {
    return /\.github\.io$/i.test(globalThis.location?.hostname ?? '');
  } catch {
    return false;
  }
}

/** "phone", "Mac" or "computer": for sentences that only need the noun swapped ("on this phone"). */
export function deviceNoun(kind: PlatformKind): string {
  return kind === 'mac' ? 'Mac' : kind === 'desktop' ? 'computer' : 'phone';
}

/** The laptop speaker and the built-in microphone are a few centimetres apart: the reason headphones matter more on a computer. */
export const SPEAKER_ECHO_NOTE =
  'A laptop or desktop speaker sits right next to its microphone, so the microphone hears the guide and your score can be wrong. Headphones fix this.';

// ---------------------------------------------------------------------------------------------
// Microphone permission

/** Where to turn the microphone back on, on a computer. */
export function desktopMicBlockedText(kind: PlatformKind, browser: DesktopBrowser): string {
  const lead = 'Microphone access was blocked.';
  // Chrome and Edge are apps that macOS lists under Microphone. Whether Safari is listed there could not be checked, so it is
  // told to look and to switch itself on only if it is.
  const system =
    kind === 'mac'
      ? browser === 'safari'
        ? ' If it still does not work, open the Apple menu, then System Settings, Privacy & Security, Microphone, and if Safari is listed there, make sure it is switched on.'
        : ' If it still does not work, open the Apple menu, then System Settings, Privacy & Security, Microphone, and check that your browser is switched on there.'
      : '';
  if (kind === 'mac' && browser === 'safari') {
    return `${lead} In Safari, choose Safari, then Settings for This Website (or Safari, Settings, Websites, Microphone; older versions say Preferences), set Microphone to Allow, then reload the page and try again.${system}`;
  }
  if (browser === 'chrome' || browser === 'edge') {
    return `${lead} Allow it in your browser’s site settings: click the icon at the left of the address bar (a padlock or sliders), open Site settings, set Microphone to Allow, then reload the page and try again.${system}`;
  }
  return `${lead} Allow the microphone for this site in your browser’s site settings (the icon at the left of the address bar), then reload the page and try again.${system}`;
}

/** The microphone-blocked words for a Mac or desktop; null on a phone (the caller keeps its own). */
export function microphoneBlockedText(env: PlatformEnv = readEnv()): string | null {
  const kind = platformKind(env);
  return isDesktopKind(kind) ? desktopMicBlockedText(kind, desktopBrowser(env)) : null;
}

// ---------------------------------------------------------------------------------------------
// Microphone placement and the level meter

export interface LevelWords {
  silent: string;
  quiet: string;
  good: string;
  hot: string;
}

export function levelWords(kind: PlatformKind): LevelWords {
  if (isDesktopKind(kind)) {
    return { silent: 'Waiting for sound', quiet: 'Quiet: move a hand-span closer to the microphone', good: 'Good level', hot: 'Too loud: move back from the microphone' };
  }
  return { silent: 'Waiting for sound', quiet: 'Quiet: hold the phone a hand-span from your mouth', good: 'Good level', hot: 'Too loud: move the phone back' };
}

export interface DistanceTip {
  /** Said before the bold part. */
  before: string;
  /** The distance, shown bold. */
  distance: string;
  after: string;
}

/** "Hold the phone or mic 20-30 cm from your mouth" in the words of the device. */
export function micDistanceTip(kind: PlatformKind): DistanceTip {
  return isDesktopKind(kind)
    ? { before: 'Sit a hand-span from the microphone, about ', distance: '20 cm', after: ', and keep that distance. A laptop microphone is usually by the keyboard or above the screen: face it.' }
    : { before: 'Hold the phone or mic ', distance: '20–30 cm', after: ' from your mouth and keep that distance.' };
}

/** The plain-text form of micDistanceTip (the Guide). */
export function micDistanceText(kind: PlatformKind): string {
  const t = micDistanceTip(kind);
  return `${t.before}${t.distance}${t.after}`;
}

// ---------------------------------------------------------------------------------------------
// Headphones, Bluetooth and the route notes

/** Said on the Guide and under the practice mode switch on a computer: why headphones help and what AirPods do. */
export function headphoneAdvice(kind: PlatformKind): string[] {
  if (!isDesktopKind(kind)) return [];
  return [
    SPEAKER_ECHO_NOTE,
    'Wired or USB headphones are the most dependable: the computer’s own microphone stays in use and the headphones only play the guide.',
    'AirPods and other Bluetooth headphones can switch to a low-quality, phone-call mode as soon as the browser uses their microphone, and add delay. If the microphone picker lists the Mac’s own microphone, choose it so the AirPods only play the guide.',
  ];
}

/** What to switch to when a Bluetooth microphone is in use. */
export function ownMicrophoneName(kind: PlatformKind): string {
  return kind === 'mac' ? 'the Mac’s own microphone' : kind === 'desktop' ? 'the computer’s own microphone' : 'the iPhone microphone';
}

// ---------------------------------------------------------------------------------------------
// Where the data lives and how to give the app a window of its own

/** "localhost:8080": the address this copy of Mimic is open at. Clips are kept per address. */
export function currentAddress(): string {
  try {
    return globalThis.location?.host || 'this address';
  } catch {
    return 'this address';
  }
}

/** Why a different browser, or a different address, shows an empty library. */
export function dataStaysHereText(address: string = currentAddress()): string {
  return `Your clips and scores are kept in this browser, for this address (${address}). Another browser, or Mimic opened at a different address, has its own empty library. A backup (Settings, then Trainer, then Export my library) carries your phrases and scores across; audio files are added again.`;
}

/** The note under the Trainer and Settings storage lines on a computer, when the browser has not promised to keep the data. */
export function desktopStorageNote(browser: DesktopBrowser, kind: PlatformKind): string {
  if (kind === 'mac' && browser === 'safari') {
    return 'Safari can clear a website’s saved data after about a week without use. Save a backup now and then (Settings, then Trainer, then Export my library); adding Mimic to the Dock (File, then Add to Dock) should protect it better.';
  }
  return 'Your clips are kept in this browser, for this address. Clearing the browser’s site data would delete them, so save a backup now and then (Settings, then Trainer, then Export my library).';
}

/** The Settings line that explains where the data is when the browser has promised nothing, in a sentence for the Trainer page. */
export function desktopMemoryOnlyAdvice(): string {
  return 'Save a backup after adding clips, and open Mimic in a normal (not private) browser window: a private window forgets everything when it closes. A backup holds your phrases and scores; the audio itself would need to be added again.';
}

export interface DockHelp {
  title: string;
  /** Numbered steps. */
  steps: string[];
  /** Said under the steps. */
  note: string;
}

/**
 * A window and Dock icon of its own for Mimic. Safari (macOS 14 Sonoma or newer) calls it Add to Dock; Chrome and Edge call it Install.
 * Null for browsers without such a thing (Firefox) and off a computer.
 */
export function dockHelp(kind: PlatformKind, browser: DesktopBrowser): DockHelp | null {
  if (!isDesktopKind(kind)) return null;
  if (kind === 'mac' && browser === 'safari') {
    return {
      title: 'Give Mimic a window of its own (optional)',
      steps: ['In Safari, choose File, then Add to Dock (macOS 14 Sonoma or newer).', 'Keep the name Mimic and choose Add.', 'Open Mimic from the Dock: it opens in its own window, without tabs.'],
      note: 'The app in the Dock should keep its own storage, so add your clips in the window you will practise in; do not count on clips added in a Safari tab showing up there.',
    };
  }
  if (browser === 'chrome' || browser === 'edge') {
    return {
      title: 'Give Mimic a window of its own (optional)',
      steps: [
        browser === 'edge' ? 'In Edge, open the ••• menu, then Apps, then Install this site as an app.' : 'In Chrome, open the ⋮ menu, then Cast, save and share, then Install page as app (or use the install icon at the right of the address bar).',
        'Choose Install.',
        'Open Mimic from the Dock or Launchpad.',
      ],
      note: 'An installed web app should share this browser’s stored data for the same address.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Interruptions and the screen

/** The Guide's "if you hear nothing / a take is interrupted" line. */
export function interruptionText(kind: PlatformKind): string {
  return isDesktopKind(kind)
    ? 'If you hear nothing, check the volume and which output is chosen (the speaker icon in the menu bar, or Sound in System Settings). Another app taking the microphone, the computer going to sleep, or Bluetooth headphones connecting or disconnecting can interrupt a take; an interrupted take is not scored, and you press Try again.'
    : 'If you hear nothing, check the volume and the ring/silent switch: the phone can silence a web page’s sound. A phone call, an alarm or another app using the microphone interrupts a take; an interrupted take is not scored, and you tap Try again.';
}

/** Studio: why a take lost its microphone, on a computer. Reasons it does not name keep the phone-neutral text. */
export const DESKTOP_INTERRUPTION_TEXT: Readonly<Record<string, string>> = {
  hidden: 'This tab was in the background, and the browser can pause the microphone then. Stay on this tab while you sing.',
  muted: 'The system or the browser muted the microphone (another app using it, or the microphone switched off in the browser’s tab menu).',
  'context-stopped': 'The browser paused the audio engine. This can happen when the computer sleeps or the headphones change.',
  'no-audio': 'No sound has reached the app yet. Check that the microphone is not muted or in use by another app, and that the right one is chosen in Settings.',
};

/** Where to get a recording to upload when the microphone will not start. */
export function recordElsewhereText(kind: PlatformKind): string {
  return isDesktopKind(kind)
    ? 'You can still get coached: record in Voice Memos or QuickTime Player on this computer, then upload the file below. Or try the demo take to see how the results look.'
    : 'You can still get coached: record a voice memo on your phone, then upload it below. Or try the demo take to see how the results look.';
}

/** The Studio's file picker hint. */
export function uploadHint(kind: PlatformKind): string {
  if (kind === 'ios') return 'WAV, MP3, M4A, AAC or FLAC from the Files app. For a Voice Memo: open it, tap ••• then Share, Save to Files, and choose it here.';
  if (isDesktopKind(kind)) return 'WAV, MP3, M4A, AAC, AIFF, OGG, WebM or FLAC. Drag a file from Finder here or choose one. A Voice Memo can be dragged out of Voice Memos onto the desktop first.';
  return 'WAV, MP3, M4A, AAC, OGG, WebM or FLAC. Drag a file here or choose one.';
}

/** The device checks line in Settings and More. */
export function deviceChecksLead(kind: PlatformKind): string {
  return isDesktopKind(kind)
    ? 'If listening, recording or timing misbehaves on this computer, these checks say what the device does and make a report you can copy or save. It holds no audio.'
    : 'If listening, recording or timing misbehaves on your phone, these checks say what the device does and make a report you can copy or save. It holds no audio.';
}

/**
 * A message written for a phone, in the words of this device: on a Mac or other computer "Tap Sing" becomes "Click Sing" and "the phone
 * was busy" becomes "the computer was busy". Anything else is returned as it was. Only for the fixed messages that name Listen and Sing.
 */
export function onThisDevice(text: string, kind: PlatformKind = platformKind()): string {
  if (!isDesktopKind(kind)) return text;
  return text
    .replace(/\bTap\b/g, 'Click')
    .replace(/\btap\b/g, 'click')
    .replace(/\btapping\b/g, 'clicking')
    .replace(/\bthe phone was busy\b/g, 'the computer was busy');
}

/** "Tap" on a phone, "click" on a computer (lower case; capitalise at the start of a sentence). */
export function tapVerb(kind: PlatformKind): string {
  return isDesktopKind(kind) ? 'click' : 'tap';
}

/** Where a person clears this site's data by hand, when the app's own delete could not remove everything. */
export function clearSiteDataWhere(env: PlatformEnv = readEnv()): string {
  const kind = platformKind(env);
  if (kind === 'ios') return 'on an iPhone: Settings, Safari, Advanced, Website Data';
  if (kind === 'mac' && desktopBrowser(env) === 'safari') return 'in Safari: Settings, Privacy, Manage Website Data';
  if (isDesktopKind(kind)) return 'in your browser: the icon at the left of the address bar, then Site settings, then Delete data';
  return 'on an iPhone: Settings, Safari, Advanced, Website Data';
}

/** What storageNote() (src/storage/quota.ts) says on a Mac or desktop instead of the Home Screen sentence; undefined on a phone. */
export function desktopNoteWords(env: PlatformEnv = readEnv()): { note: string } | undefined {
  const kind = platformKind(env);
  return isDesktopKind(kind) ? { note: desktopStorageNote(desktopBrowser(env), kind) } : undefined;
}

/**
 * "Hold the phone about a hand-span from your mouth" on a phone, "Sit about a hand-span from the microphone" on a computer.
 * `capital` starts a sentence with it. Read once at load by the analysis and trainer messages, which are plain constants.
 */
export function handSpanAdvice(kind: PlatformKind, capital = true): string {
  const text = isDesktopKind(kind) ? 'sit about a hand-span from the microphone' : 'hold the phone about a hand-span from your mouth';
  return capital ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
