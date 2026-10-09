// @vitest-environment jsdom
// What a person on a Mac (or another computer) reads: no Home Screen, no Files app, no phone held to the mouth. The platform is
// injected: through props where a component takes one, otherwise by giving jsdom's navigator a Mac user agent. A phone and a bare
// test DOM keep the words the app shipped with (the other test files pin those).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteInfo } from '../audio/duplex';
import { VIDEO_SHORTCUT_TIP, videoShortcutTip } from '../audio/decode';
import { routeNotes } from '../audio/route';
import type { PlatformEnv } from '../pwa/platform';
import { AppContext, type AppController } from '../state/context';
import { createInitialState } from '../state/reducer';
import { TrainerExtrasContext, type TrainerExtras } from '../state/TrainerProvider';
import { storageNote, UNKNOWN_STORAGE } from '../storage/quota';
import { makeFakeProfile } from '../testing/fixtures';
import { DEFAULT_PRACTICE_OPTIONS, makeFakeTrainerController } from '../testing/trainerFixtures';
import { tick, useScreen } from '../testing/trainerUi';
import { importWords, isolateCostText, interruptedSplitText, isolatedToneNote, ISOLATED_TONE_NOTE } from '../trainer/importCopy';
import { desktopNoteWords } from '../pwa/words';
import { DesktopInstallCard } from './components/InstallCard';
import { PracticeControls, PracticeDock } from './components/PracticeControls';
import { MicrophoneSetting, StoragePanel } from './components/StoragePanel';
import { TrainerEmpty } from './components/TrainerEmpty';
import { GuidePage } from './pages/Guide';
import { StudioPage } from './pages/Studio';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

function setNavigator(userAgent: string, platform: string, touch = 0): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touch });
}
const asMacSafari = () => setNavigator(MAC_SAFARI, 'MacIntel');
const asMacChrome = () => setNavigator(MAC_CHROME, 'MacIntel');
const asIphone = () => setNavigator(IPHONE, 'iPhone', 5);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const key of ['userAgent', 'platform', 'maxTouchPoints']) Reflect.deleteProperty(navigator, key);
});

const text = () => container.textContent ?? '';

describe('Trainer empty state', () => {
  it('on a Mac: Finder, Voice Memos by drag, Show in Finder for purchases, QuickTime for video; nothing about Files, AirDrop or Shortcuts', () => {
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} platform="mac" />));
    expect(Array.from(container.querySelectorAll('.te-step-title')).map((e) => e.textContent)).toEqual(['Find the file', 'Add it here', 'Practise phrase by phrase']);
    expect(container.querySelector('.te-ways summary')?.textContent).toBe('Ways to get a vocal onto your Mac');
    expect(text()).toMatch(/Finder/);
    expect(text()).toMatch(/Voice Memos/);
    expect(text()).toMatch(/Show in Finder/);
    expect(text()).toMatch(/QuickTime Player/);
    expect(text()).toMatch(/AIFF/);
    expect(text()).not.toMatch(/Files app|AirDrop|Save to Files|iCloud Drive on your phone|Encode Media|Shortcuts|iPhone/);
  });

  it('says what Apple Music and iTunes files can and cannot be read', () => {
    const w = importWords('mac');
    expect(w.protectedHelp).toMatch(/Apple Music subscription are copy-protected/);
    expect(w.protectedHelp).toMatch(/\.m4p/);
    expect(w.protectedHelp).toMatch(/since 2009 are normally plain M4A/);
    expect(w.protectedHelp).toMatch(/CD rips/);
  });

  it('on an iPhone and in a bare test DOM the phone words are unchanged', () => {
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} platform="ios" />));
    expect(text()).toMatch(/Files app/);
    expect(text()).toMatch(/Encode Media/);
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} />));
    expect(text()).toMatch(/Ways to get a vocal onto your phone/);
  });

  it('reads the real device when no platform is given', () => {
    asMacChrome();
    act(() => root.render(<TrainerEmpty onAdd={() => undefined} />));
    expect(text()).toMatch(/Ways to get a vocal onto your Mac/);
  });
});

describe('the import copy for isolation', () => {
  it('a Mac is told about the fans and sleep, not battery and locking the phone', () => {
    const t = isolateCostText(19, false, 'mac');
    expect(t).toMatch(/this Mac|in this browser/);
    expect(t).toMatch(/fans may spin up/);
    expect(t).not.toMatch(/battery|phone/);
    expect(isolateCostText(19, true, 'mac')).toMatch(/already on this Mac/);
    expect(isolateCostText(19, false, 'ios')).toMatch(/battery/);
    expect(isolateCostText(19, false)).toBe(isolateCostText(19, false, 'other'));
    expect(interruptedSplitText('Song.m4a', 120, 'mac')).toMatch(/computer went to sleep/);
    expect(interruptedSplitText('Song.m4a', 120)).toMatch(/screen locked/);
    expect(isolatedToneNote('mac')).toMatch(/on this Mac/);
    expect(isolatedToneNote('other')).toBe(ISOLATED_TONE_NOTE);
  });
});

describe('the Dock card', () => {
  const env = (userAgent: string, platform: string, over: Partial<PlatformEnv> = {}): PlatformEnv => ({
    userAgent,
    platform,
    maxTouchPoints: 0,
    standaloneFlag: undefined,
    displayModeStandalone: false,
    ...over,
  });

  it('Safari on a Mac: where the data lives, then File > Add to Dock', () => {
    act(() => root.render(<DesktopInstallCard env={env(MAC_SAFARI, 'MacIntel')} address="localhost:8080" />));
    expect(text()).toMatch(/for this address \(localhost:8080\)/);
    expect(text()).toMatch(/File, then Add to Dock/);
    expect(text()).toMatch(/own window/);
    expect(text()).not.toMatch(/Home Screen/);
  });

  it('Chrome on a Mac: Install page as app', () => {
    act(() => root.render(<DesktopInstallCard env={env(MAC_CHROME, 'MacIntel')} address="localhost:8080" />));
    expect(text()).toMatch(/Install page as app/);
  });

  it('already running in its own window: says so, and no steps', () => {
    act(() => root.render(<DesktopInstallCard env={env(MAC_SAFARI, 'MacIntel', { displayModeStandalone: true })} address="localhost:8080" />));
    expect(text()).toMatch(/running in its own window/);
    expect(container.querySelector('.install-steps')).toBeNull();
  });

  it('renders nothing on an iPhone (it has its own Home Screen card)', () => {
    act(() => root.render(<DesktopInstallCard env={env(IPHONE, 'iPhone', { maxTouchPoints: 5 })} />));
    expect(text()).toBe('');
  });
});

describe('storage wording', () => {
  it('the one-sentence note: Safari on a Mac points to a backup and the Dock, never the Home Screen', () => {
    asMacSafari();
    const note = storageNote({ ...UNKNOWN_STORAGE, persisted: false }, { memoryOnly: false, installed: false, desktop: desktopNoteWords() });
    expect(note).toMatch(/Add to Dock/);
    expect(note).toMatch(/Export my library/);
    expect(note).not.toMatch(/Home Screen/);
  });

  it('Chrome on a Mac: browser data, this address, a backup', () => {
    asMacChrome();
    expect(storageNote({ ...UNKNOWN_STORAGE, persisted: false }, { memoryOnly: false, installed: false, desktop: desktopNoteWords() })).toMatch(/kept in this browser, for this address/);
  });

  it('with no platform given the Home Screen sentence is kept', () => {
    expect(storageNote({ ...UNKNOWN_STORAGE, persisted: false }, { memoryOnly: false, installed: false })).toMatch(/Home Screen/);
  });
});

describe('Settings > Offline and storage on a Mac', () => {
  const screen = useScreen();
  beforeEach(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist: async () => false, estimate: async () => ({ usage: 118 * 1048576, quota: 5.6 * 1073741824 }) },
    });
  });
  const extras: TrainerExtras = {
    memoryReason: null,
    warnings: [],
    exportReminder: { due: false, message: null },
    storageNote: null,
    reload: () => Promise.resolve(),
    refreshStorage: () => Promise.resolve({ supported: true, usage: 1, quota: 2, persisted: false }),
    requestPersistence: () => Promise.resolve(false),
  };
  const mount = () =>
    screen.mount(
      <TrainerExtrasContext.Provider value={extras}>
        <StoragePanel />
      </TrainerExtrasContext.Provider>,
      makeFakeTrainerController(),
    );

  it('says "browser window", offers Add to Dock in Safari, and keeps the iPhone card away', async () => {
    asMacSafari();
    mount();
    await tick();
    const body = screen.q('.settings-section')?.textContent ?? '';
    expect(body).toMatch(/Running in a browser window/);
    expect(body).toMatch(/File, then Add to Dock/);
    expect(body).not.toMatch(/Install Mimic on your iPhone|Add to Home Screen/);
    expect(screen.q('[data-testid="desktop-install-card"]')).not.toBeNull();
  });

  it('on an iPhone in a browser tab it still shows the Home Screen card, and no Dock card', async () => {
    asIphone();
    mount();
    await tick();
    expect(screen.qa('[data-testid="desktop-install-card"]')).toHaveLength(0);
    expect(screen.q('.settings-section').textContent ?? '').toMatch(/Install Mimic on your iPhone/);
  });

  it('the microphone picker talks about the computer and the Mac\'s own microphone', async () => {
    asMacChrome();
    const devices: { kind: string; deviceId: string; label: string; groupId: string }[] = [];
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: async () => devices } });
    screen.mount(<MicrophoneSetting />);
    await tick();
    expect(screen.q('.field').textContent).toMatch(/whatever the computer is using/);
    expect(screen.q('.field').textContent).toMatch(/Click Record in the Studio/);
    expect(screen.q('.field').textContent).not.toMatch(/\bphone\b/);
    devices.push({ kind: 'audioinput', deviceId: 'a', label: 'AirPods Pro', groupId: 'g1' }, { kind: 'audioinput', deviceId: 'b', label: 'MacBook Pro Microphone', groupId: 'g2' });
    screen.unmount();
    screen.mount(<MicrophoneSetting />);
    await tick();
    expect(screen.q('.field').textContent).toMatch(/Choose the Mac’s own microphone for takes you want to compare/);
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });
});

describe('Guide on a Mac', () => {
  function guide(platform?: 'mac' | 'ios') {
    const app = { state: createInitialState({ voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' }, [], []) } as unknown as AppController;
    act(() =>
      root.render(
        <AppContext.Provider value={app}>
          <GuidePage platform={platform} />
        </AppContext.Provider>,
      ),
    );
  }

  it('uses computer words for the microphone, files, headphones and storage', () => {
    asMacSafari();
    guide('mac');
    expect(container.querySelector('.guide-toc')?.textContent).toMatch(/Getting a vocal onto your Mac/);
    expect(text()).toMatch(/Sit a hand-span from the microphone, about 20 cm/);
    expect(text()).toMatch(/Headphones, speakers and AirPods/);
    expect(text()).toMatch(/speaker sits right next to its microphone/);
    expect(text()).toMatch(/I have headphones on/);
    expect(text()).toMatch(/Sound in System Settings/);
    expect(text()).toMatch(/File, then Add to Dock/);
    expect(text()).toMatch(/Show in Finder/);
    expect(text()).not.toMatch(/Files app|AirDrop|ring\/silent|Hold the phone|Install Mimic on your iPhone/);
  });

  it('on an iPhone the phone words stay', () => {
    guide('ios');
    expect(text()).toMatch(/Hold the phone or microphone 20–30 cm/);
    expect(text()).toMatch(/ring\/silent switch/);
    expect(text()).toMatch(/Files app/);
    expect(container.querySelector('[data-testid="desktop-install-card"]')).toBeNull();
  });
});

describe('Studio on a Mac', () => {
  const BUILTINS = [makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', tagline: 'Bright pop tenor mix', color: '#b97a12' })];
  function studio() {
    const state = createInitialState({ voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' }, [], BUILTINS);
    const app = {
      state,
      dispatch: vi.fn(),
      builtins: BUILTINS,
      profiles: BUILTINS,
      profile: BUILTINS[0],
      route: 'studio',
      go: vi.fn(),
      theme: 'system',
      setTheme: vi.fn(),
    } as unknown as AppController;
    act(() =>
      root.render(
        <AppContext.Provider value={app}>
          <StudioPage />
        </AppContext.Provider>,
      ),
    );
  }

  it('the tips and the upload hint are about the Mac, not a phone held to the mouth', () => {
    asMacSafari();
    studio();
    const tips = container.querySelector('.tips')?.textContent ?? '';
    expect(tips).toMatch(/Sit a hand-span from the microphone, about 20 cm/);
    expect(tips).not.toMatch(/Hold the phone/);
    expect(text()).toMatch(/Drag a file from Finder here/);
    expect(text()).not.toMatch(/Files app|Voice Memo: open it, tap/);
  });

  it('an iPhone keeps its tips and the Files-app hint', () => {
    asIphone();
    studio();
    expect(container.querySelector('.tips')?.textContent).toMatch(/Hold the phone or mic 20–30 cm from your mouth/);
    expect(text()).toMatch(/from the Files app/);
  });
});

describe('the practice screen on a Mac', () => {
  const MAC_BUILTIN: RouteInfo = {
    inputLabel: 'MacBook Pro Microphone',
    inputs: [{ id: 'a', label: 'MacBook Pro Microphone' }],
    kind: 'builtin',
    headphonesLikely: false,
    sampleRate: 48000,
  };
  const AIRPODS: RouteInfo = {
    inputLabel: 'AirPods Pro',
    inputs: [
      { id: 'a', label: 'AirPods Pro' },
      { id: 'b', label: 'MacBook Pro Microphone' },
    ],
    kind: 'bluetooth',
    headphonesLikely: true,
    sampleRate: 16000,
    inputSampleRate: 16000,
  };
  const noop = () => undefined;

  it('built-in speaker and microphone: the question before singing along names the laptop speaker', () => {
    asMacSafari();
    act(() => root.render(<PracticeDock options={{ ...DEFAULT_PRACTICE_OPTIONS, mode: 'sing-along' }} state="idle" route={MAC_BUILTIN} hasResult={false} onOptions={noop} onListen={noop} onSing={noop} onStop={noop} onFinish={noop} />));
    act(() => (Array.from(container.querySelectorAll('button')).find((b) => /^\s*Sing/.test(b.textContent ?? '')) as HTMLButtonElement).click());
    const ask = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(ask).toMatch(/laptop or desktop speaker sits right next to its microphone/);
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(['Listen first, then sing', 'I have headphones on']));
  });

  it('AirPods on a Mac: warns about the phone-call mode and points to the Mac\'s own microphone', () => {
    asMacChrome();
    const f = vi.fn();
    act(() => root.render(<PracticeControls options={DEFAULT_PRACTICE_OPTIONS} state="idle" route={AIRPODS} keyHint={null} durationSec={6} onOptions={noop} onOpenMicSettings={f} />));
    expect(text()).toMatch(/Bluetooth drops to phone-call quality/);
    expect(text()).toMatch(/Use the Mac’s own microphone instead; the headphones still play the guide/);
    expect(text()).not.toMatch(/iPhone/);
    expect(text()).toMatch(/records at 16 kHz/);
  });

  it('the route notes themselves: Mac wording only when asked for, phone wording by default', () => {
    expect(routeNotes(AIRPODS, 'turn-taking', 'mac').find((n) => n.id === 'bluetooth-mic')?.message).toMatch(/Mac’s own microphone/);
    expect(routeNotes(AIRPODS).find((n) => n.id === 'bluetooth-mic')?.message).toMatch(/Use the iPhone microphone instead/);
    expect(routeNotes(MAC_BUILTIN, 'sing-along', 'mac').find((n) => n.id === 'speaker-sing-along')?.message).toMatch(/laptop or desktop speaker/);
    expect(routeNotes(MAC_BUILTIN, 'turn-taking', 'mac').find((n) => n.id === 'no-headphones')?.message).toMatch(/Headphones without a microphone cannot be seen by a browser/);
    expect(routeNotes({ ...MAC_BUILTIN, labelsHidden: true, inputs: [{ id: 'a', label: '' }], inputLabel: '' }, 'turn-taking', 'mac').find((n) => n.id === 'labels-hidden')?.message).toMatch(/Click Sing once/);
  });
});

describe('a video that is too big, on a Mac', () => {
  it('points to QuickTime Player, not the Shortcuts app and Photos', () => {
    asMacSafari();
    expect(videoShortcutTip()).toMatch(/QuickTime Player choose File, then Export As, then Audio Only/);
    expect(videoShortcutTip()).not.toMatch(/Shortcuts|Photos|Files/);
    asIphone();
    expect(videoShortcutTip()).toBe(VIDEO_SHORTCUT_TIP);
  });
});
