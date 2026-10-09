import { afterEach, describe, expect, it, vi } from 'vitest';
import { importWords, isolateCostText } from '../trainer/importCopy';
import type { PlatformEnv } from './platform';
import {
  clearSiteDataWhere,
  dataStaysHereText,
  desktopMicBlockedText,
  desktopNoteWords,
  desktopStorageNote,
  dockHelp,
  deviceChecksLead,
  deviceNoun,
  handSpanAdvice,
  headphoneAdvice,
  interruptionText,
  levelWords,
  micDistanceText,
  microphoneBlockedText,
  onGithubPages,
  onLocalServer,
  onThisDevice,
  ownMicrophoneName,
  recordElsewhereText,
  tapVerb,
  uploadHint,
} from './words';

const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const env = (userAgent: string, platform: string, maxTouchPoints = 0): PlatformEnv => ({ userAgent, platform, maxTouchPoints, standaloneFlag: undefined, displayModeStandalone: false });

describe('microphone permission words', () => {
  it('Safari on a Mac: Settings for This Website / Settings, Websites, Microphone, and the macOS privacy switch', () => {
    const t = microphoneBlockedText(env(SAFARI_MAC, 'MacIntel')) ?? '';
    expect(t).toMatch(/Settings for This Website/);
    expect(t).toMatch(/Settings, Websites, Microphone/);
    expect(t).toMatch(/System Settings, Privacy & Security, Microphone/);
    expect(t).not.toMatch(/iPhone|aA/);
  });

  it('Chrome on a Mac: the icon at the left of the address bar, Site settings, and the macOS privacy switch', () => {
    const t = microphoneBlockedText(env(CHROME_MAC, 'MacIntel')) ?? '';
    expect(t).toMatch(/left of the address bar/);
    expect(t).toMatch(/Site settings/);
    expect(t).toMatch(/Privacy & Security/);
  });

  it('another desktop gets site settings without the macOS step; a phone gets null (it keeps its own words)', () => {
    expect(desktopMicBlockedText('desktop', 'chrome')).not.toMatch(/Apple menu|System Settings/);
    expect(microphoneBlockedText(env(IPHONE, 'iPhone', 5))).toBeNull();
  });
});

describe('the device noun and the verbs', () => {
  it('says Mac, computer or phone', () => {
    expect(deviceNoun('mac')).toBe('Mac');
    expect(deviceNoun('desktop')).toBe('computer');
    expect(deviceNoun('ios')).toBe('phone');
    expect(deviceNoun('other')).toBe('phone');
    expect(tapVerb('mac')).toBe('click');
    expect(tapVerb('ios')).toBe('tap');
  });
});

describe('microphone distance and the level meter', () => {
  it('a laptop is a hand-span from the microphone, not a phone held to the mouth', () => {
    expect(micDistanceText('mac')).toMatch(/hand-span from the microphone/);
    expect(micDistanceText('mac')).not.toMatch(/\bphone\b/);
    expect(micDistanceText('ios')).toBe('Hold the phone or mic 20–30 cm from your mouth and keep that distance.');
    expect(levelWords('mac').quiet).toBe('Quiet: move a hand-span closer to the microphone');
    expect(levelWords('mac').hot).toBe('Too loud: move back from the microphone');
    expect(levelWords('ios').quiet).toBe('Quiet: hold the phone a hand-span from your mouth');
    expect(levelWords('other').hot).toBe('Too loud: move the phone back');
    expect(handSpanAdvice('mac')).toBe('Sit about a hand-span from the microphone');
    expect(handSpanAdvice('ios', false)).toBe('hold the phone about a hand-span from your mouth');
  });
});

describe('headphones matter more on a computer', () => {
  it('explains the speaker echo and what AirPods do, and says nothing extra on a phone', () => {
    const lines = headphoneAdvice('mac').join(' ');
    expect(lines).toMatch(/speaker sits right next to its microphone/);
    expect(lines).toMatch(/AirPods/);
    expect(lines).toMatch(/phone-call mode/);
    expect(headphoneAdvice('ios')).toEqual([]);
    expect(ownMicrophoneName('mac')).toBe('the Mac’s own microphone');
    expect(ownMicrophoneName('ios')).toBe('the iPhone microphone');
  });
});

describe('where the data lives, and the Dock', () => {
  it('names the address and says another browser or address starts empty', () => {
    const t = dataStaysHereText('localhost:8080');
    expect(t).toMatch(/this browser, for this address \(localhost:8080\)/);
    expect(t).toMatch(/empty library/);
  });

  it('Safari on a Mac: File, Add to Dock (Sonoma), and "should" about storage because it was not checked on a Mac', () => {
    const help = dockHelp('mac', 'safari');
    expect(help?.steps[0]).toMatch(/File, then Add to Dock/);
    expect(help?.steps[0]).toMatch(/macOS 14 Sonoma/);
    expect(help?.note).toMatch(/should keep its own storage/);
  });

  it('Chrome and Edge say Install; Firefox and phones have no card', () => {
    expect(dockHelp('mac', 'chrome')?.steps[0]).toMatch(/Install page as app/);
    expect(dockHelp('desktop', 'edge')?.steps[0]).toMatch(/Install this site as an app/);
    expect(dockHelp('mac', 'firefox')).toBeNull();
    expect(dockHelp('ios', 'safari')).toBeNull();
  });

  it('the storage note on Safari points to a backup and the Dock; on Chrome only to a backup; a phone gets undefined', () => {
    expect(desktopStorageNote('safari', 'mac')).toMatch(/about a week/);
    expect(desktopStorageNote('safari', 'mac')).toMatch(/Add to Dock/);
    expect(desktopStorageNote('chrome', 'mac')).toMatch(/Export my library/);
    expect(desktopStorageNote('chrome', 'mac')).not.toMatch(/Home Screen|Dock/);
    expect(desktopNoteWords(env(IPHONE, 'iPhone', 5))).toBeUndefined();
    expect(desktopNoteWords(env(SAFARI_MAC, 'MacIntel'))?.note).toMatch(/Add to Dock/);
  });

  it('where to clear a site by hand depends on the browser', () => {
    expect(clearSiteDataWhere(env(IPHONE, 'iPhone', 5))).toMatch(/Settings, Safari, Advanced, Website Data/);
    expect(clearSiteDataWhere(env(SAFARI_MAC, 'MacIntel'))).toMatch(/Manage Website Data/);
    expect(clearSiteDataWhere(env(CHROME_MAC, 'MacIntel'))).toMatch(/Site settings/);
  });
});

describe('interruptions, uploads and checks', () => {
  it('a computer is told about output choice and sleep, not the ring/silent switch', () => {
    expect(interruptionText('mac')).toMatch(/Sound in System Settings/);
    expect(interruptionText('mac')).not.toMatch(/ring\/silent/);
    expect(interruptionText('ios')).toMatch(/ring\/silent switch/);
  });

  it('the Studio upload hint and the fallback advice use Finder and Voice Memos / QuickTime on a Mac', () => {
    expect(uploadHint('mac')).toMatch(/AIFF/);
    expect(uploadHint('mac')).toMatch(/Finder/);
    expect(uploadHint('mac')).not.toMatch(/Files app/);
    expect(uploadHint('ios')).toMatch(/from the Files app/);
    expect(recordElsewhereText('mac')).toMatch(/Voice Memos or QuickTime Player/);
    expect(recordElsewhereText('ios')).toMatch(/on your phone/);
    expect(deviceChecksLead('mac')).toMatch(/on this computer/);
    expect(deviceChecksLead('other')).toMatch(/on your phone/);
  });
});

describe('Safari and the macOS microphone list', () => {
  it('Safari is only told to switch itself on if it is listed under Privacy & Security, Microphone; Chrome is told to check its entry', () => {
    const safari = microphoneBlockedText(env(SAFARI_MAC, 'MacIntel')) ?? '';
    expect(safari).toMatch(/if Safari is listed there, make sure it is switched on/);
    expect(safari).not.toMatch(/check that your browser is switched on/);
    const chrome = microphoneBlockedText(env(CHROME_MAC, 'MacIntel')) ?? '';
    expect(chrome).toMatch(/check that your browser is switched on there/);
  });
});

describe('onThisDevice', () => {
  const phoneText = 'The recording had a gap in it (the phone was busy). Close other apps, then tap Sing again. Tap Listen to hear it; tapping Stop ends it.';
  it('says click and the computer on a Mac or other computer', () => {
    expect(onThisDevice(phoneText, 'mac')).toBe('The recording had a gap in it (the computer was busy). Close other apps, then click Sing again. Click Listen to hear it; clicking Stop ends it.');
    expect(onThisDevice(phoneText, 'desktop')).toMatch(/click Sing again/);
  });
  it('leaves a phone, or anything it cannot recognise, exactly as it was', () => {
    for (const kind of ['ios', 'other'] as const) expect(onThisDevice(phoneText, kind)).toBe(phoneText);
  });
  it('does not touch other words that merely contain tap', () => {
    expect(onThisDevice('Stapler, tape and a tap-to-click trackpad', 'mac')).toBe('Stapler, tape and a click-to-click trackpad');
  });
});

describe('where Mimic is served from', () => {
  afterEach(() => vi.unstubAllGlobals());
  const at = (hostname: string) => vi.stubGlobal('location', { hostname, host: hostname });

  it('knows the Mac download (localhost) from a hosted copy and from GitHub Pages', () => {
    at('localhost');
    expect(onLocalServer()).toBe(true);
    expect(onGithubPages()).toBe(false);
    at('127.0.0.1');
    expect(onLocalServer()).toBe(true);
    at('singer.github.io');
    expect(onLocalServer()).toBe(false);
    expect(onGithubPages()).toBe(true);
    at('example.com');
    expect(onLocalServer()).toBe(false);
    expect(onGithubPages()).toBe(false);
  });

  it('the vocal-isolation cost says copied from the Mimic folder on the Mac download, downloaded from this site elsewhere', () => {
    at('localhost');
    expect(isolateCostText(20, false, 'mac')).toMatch(/copies about 31 MB .* from the Mimic folder on this Mac and keeps them in this browser/);
    expect(isolateCostText(20, false, 'mac')).not.toMatch(/downloads|from this site/);
    expect(isolateCostText(20, false, 'ios')).toMatch(/downloads about 31 MB from this site/);
    at('example.com');
    expect(isolateCostText(20, false, 'mac')).toMatch(/downloads about 31 MB from this site/);
  });

  it('the list of ways to get a vocal does not say "CD rips" twice', () => {
    const body = importWords('mac').ways.find((w) => /copy protection/.test(w.title))?.body ?? '';
    expect(body.match(/CD rips/g)?.length).toBe(1);
  });

  it('the Add clips sheet does not tell you to click a button that is not in it', () => {
    const mac = importWords('mac');
    expect(mac.steps.find((st) => st.title === 'Add it here')?.body).toMatch(/Click Add clips/);
    const inSheet = mac.sheetSteps.find((st) => st.title === 'Add it here')?.body ?? '';
    expect(inSheet).toMatch(/Choose files above/);
    expect(inSheet).not.toMatch(/Add clips/);
    expect(importWords('ios').sheetSteps).toBe(importWords('ios').steps);
  });
});
