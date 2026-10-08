// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeProfile } from '../../testing/fixtures';
import { littleMixSingingReason, littleSingingReason, MIX_REASON, SPEECH_REASON } from '../../trainer/importCopy';
import { preparedKind, type CommitEdits, type PreparedClip } from '../../trainer/import';
import { fakePrepared } from '../../trainer/importTestKit';
import type { ClipKind, VoiceAnalysis } from '../../types';
import { ClipReview, type ClipReviewProps } from './ClipReview';
import type { SamplePlayer, SamplePlayOptions } from './samplePlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const SINGERS = [
  makeFakeProfile({ id: 'shawn-mendes', name: 'Shawn Mendes', color: '#b97a12' }),
  makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar', color: '#3a7556' }),
];

interface FakePlayer extends SamplePlayer {
  calls: { samples: Float32Array; rate: number; opts?: SamplePlayOptions }[];
  finish(): void;
  playResult: boolean;
}

function fakePlayer(): FakePlayer {
  let ended: (() => void) | undefined;
  let active = false;
  const player: FakePlayer = {
    calls: [],
    playResult: true,
    play: vi.fn(async (samples: Float32Array, rate: number, opts?: SamplePlayOptions) => {
      player.calls.push({ samples, rate, opts });
      ended = opts?.onEnded;
      active = player.playResult;
      return player.playResult;
    }),
    stop: vi.fn(() => {
      active = false;
      ended = undefined;
    }),
    position: () => (active ? 3 : null),
    get playing() {
      return active;
    },
    dispose: vi.fn(),
    finish() {
      active = false;
      ended?.();
    },
  };
  return player;
}

interface Mounted {
  props: ClipReviewProps;
  player: FakePlayer;
  saved: { edits: CommitEdits; prepared: PreparedClip }[];
}

function mount(over: Partial<ClipReviewProps> = {}, prepared: PreparedClip = fakePrepared()): Mounted {
  const player = fakePlayer();
  const saved: Mounted['saved'] = [];
  const props: ClipReviewProps = {
    prepared,
    singers: SINGERS,
    onSave: (edits, p) => void saved.push({ edits, prepared: p }),
    createPlayer: () => player,
    ...over,
  };
  act(() => root.render(<ClipReview {...props} />));
  return { props, player, saved };
}

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = container.querySelector<T>(sel);
  if (!el) throw new Error(`Nothing matches ${sel}`);
  return el;
};
const $$ = <T extends Element = HTMLElement>(sel: string): T[] => Array.from(container.querySelectorAll<T>(sel));
const button = (text: RegExp): HTMLButtonElement => {
  const b = $$<HTMLButtonElement>('button').find((el) => text.test(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`));
  if (!b) throw new Error(`No button matching ${text}`);
  return b;
};
const hasButton = (text: RegExp): boolean => $$<HTMLButtonElement>('button').some((el) => text.test(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`));
const click = (el: Element) => act(() => (el as HTMLElement).click());
const clickAsync = (el: Element) => act(async () => (el as HTMLElement).click());
const owned = () => $<HTMLInputElement>('.rev-footer .rev-owned input[type="checkbox"]');
/** Save and the full-song switch are aria-disabled, not disabled: the control that was just pressed keeps the focus. */
const blocked = (el: HTMLElement): boolean => el.getAttribute('aria-disabled') === 'true';
const tickOwned = () => click(owned());
const saveButton = () => button(/Save clip|Saving/);

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ClipReview: a solo clip', () => {
  it('starts at its own heading, so a new clip is announced', () => {
    mount();
    expect(document.activeElement).toBe($('.rev-title'));
    expect($('.rev-title').tagName).toBe('H3');
  });

  it('shows what was found and what to do next, with Save waiting for the ownership tick', () => {
    mount({ position: { index: 1, count: 3 } });
    expect(container.textContent).toContain('Clip 2 of 3');
    expect(container.textContent).toContain('Verse take.wav');
    expect(container.textContent).toMatch(/3 phrases to practise/);
    expect($<HTMLInputElement>('input[type="text"]').value).toBe('Verse take');
    expect(blocked(saveButton())).toBe(true);
    // The tick is next to the button it unlocks, inside the pinned footer, and names the file it is about.
    expect($('.rev-footer .rev-owned').textContent).toMatch(/I own this file or have the right to practise with it\.Verse take\.wav/);
    tickOwned();
    expect(blocked(saveButton())).toBe(false);
    expect($$('.rev-why')).toHaveLength(0);
  });

  it('does not start with the ownership box ticked, and pressing Save without it takes the person to the box', () => {
    const m = mount();
    expect(owned().checked).toBe(false);
    saveButton().focus();
    click(saveButton());
    expect(m.saved).toHaveLength(0);
    expect(document.activeElement).toBe(owned());
    expect($('[role="status"]').textContent).toMatch(/Tick the box to say this file is yours/);
    // The button was never disabled, so a keyboard or VoiceOver user pressing it is not thrown out to the page.
    expect(saveButton().disabled).toBe(false);
    tickOwned();
    click(saveButton());
    expect(m.saved).toHaveLength(1);
  });

  it('pressing Save for another reason says why and moves the focus to the reason', () => {
    const m = mount();
    tickOwned();
    const phraseCount = $$('.pe-item').length;
    expect(phraseCount).toBeGreaterThan(0);
    // Hide every phrase through the editor, one after the other.
    for (let i = 0; i < phraseCount; i++) {
      click($$('.pe-item')[i]);
      const hideBtn = $$<HTMLButtonElement>('button').find((b) => /^Hide phrase$/.test(b.textContent ?? ''));
      if (hideBtn) click(hideBtn);
    }
    expect($$('.rev-why')).toHaveLength(1);
    saveButton().focus();
    click(saveButton());
    expect(m.saved).toHaveLength(0);
    expect(document.activeElement).toBe($('.rev-why'));
    expect($('[role="status"]').textContent).toMatch(/Show at least one phrase/);
  });

  it('hands the edits and the clip to onSave', () => {
    const m = mount();
    tickOwned();
    click(saveButton());
    expect(m.saved).toHaveLength(1);
    const { edits, prepared } = m.saved[0];
    expect(prepared).toBe(m.props.prepared);
    expect(edits).toMatchObject({ title: 'Verse take', singerId: null, singerLabel: '', kind: 'solo', contributeToSinger: false, ownedConfirmed: true });
    expect(edits.phrases).toHaveLength(3);
    expect(edits.trim).toEqual({ startSec: 0, endSec: 21.5 }); // the singing (1 s to 20.5 s) and a second either side
    expect(edits.vocalStem).toBeUndefined();
  });

  it('passes on a new title, the chosen singer and a name for someone else', () => {
    const m = mount();
    tickOwned();
    typeInto($<HTMLInputElement>('input[type="text"]'), '  Chorus, take 2 ');
    click($$('.rev-chip input')[1]); // Daniel
    click(saveButton());
    expect(m.saved[0].edits).toMatchObject({ title: 'Chorus, take 2', singerId: 'daniel-caesar', singerLabel: '' });

    click($$('.rev-chip input')[2]); // Someone else
    typeInto($$<HTMLInputElement>('input[type="text"]')[1], ' A friend ');
    click(saveButton());
    expect(m.saved[1].edits).toMatchObject({ singerId: null, singerLabel: 'A friend' });
    // A blank title falls back to the file name.
    typeInto($<HTMLInputElement>('input[type="text"]'), '   ');
    click(saveButton());
    expect(m.saved[2].edits.title).toBe('Verse take');
  });

  it('offers to add the clip to a singer\'s targets only for a builtin singer, and passes the choice on', () => {
    const m = mount();
    tickOwned();
    expect($$('.rev-targets')).toHaveLength(0);
    click($$('.rev-chip input')[0]);
    expect($('.rev-targets').textContent).toMatch(/Add to Shawn.s targets/);
    expect($('.rev-targets').textContent).toMatch(/Only numbers are kept, not audio/);
    const box = $<HTMLInputElement>('.rev-targets input');
    expect(box.checked).toBe(false);
    click(box);
    click(saveButton());
    expect(m.saved[0].edits).toMatchObject({ singerId: 'shawn-mendes', contributeToSinger: true });
    // Someone else: no targets option, and the choice is not carried over.
    click($$('.rev-chip input')[2]);
    expect($$('.rev-targets')).toHaveLength(0);
    click(saveButton());
    expect(m.saved[1].edits.contributeToSinger).toBe(false);
  });

  it('explains why a clip with too little singing cannot count toward targets', () => {
    const short = fakePrepared({ spans: [{ start: 1, end: 4 }, { start: 8, end: 9.5 }], name: 'short.wav' });
    mount({}, short);
    click($$('.rev-chip input')[0]);
    const box = $<HTMLInputElement>('.rev-targets input');
    expect(box.disabled).toBe(true);
    expect($('.rev-targets').textContent).toMatch(/too little/i);
  });

  it('remembers the ownership tick through the callbacks', () => {
    const onOwnedChange = vi.fn();
    mount({ ownedDefault: true, onOwnedChange });
    expect(owned().checked).toBe(true);
    expect(blocked(saveButton())).toBe(false);
    click(owned());
    expect(onOwnedChange).toHaveBeenLastCalledWith(false);
    expect(blocked(saveButton())).toBe(true);
  });

  it('shows saving and save errors, and does not save twice', () => {
    const m = mount({ saving: true, saveError: 'Not enough room on this device. Remove clips you no longer practise.' });
    tickOwned();
    expect(saveButton().textContent).toMatch(/Saving/);
    expect(blocked(saveButton())).toBe(true);
    expect(container.textContent).toMatch(/The clip was not saved/);
    expect(container.textContent).toMatch(/Remove clips you no longer practise/);
    expect(m.saved).toHaveLength(0);
  });

  it('offers Skip when there is a queue', () => {
    const onSkip = vi.fn();
    mount({ onSkip });
    click(button(/Skip this file/));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('shows decode notices and warnings above the details', () => {
    mount({}, fakePrepared({ notices: ['Used the sound of the video.'], warnings: ['There is a lot of background noise in this clip, so the notes may be harder to follow.'] }));
    expect(container.textContent).toContain('Used the sound of the video.');
    expect(container.textContent).toContain('background noise');
    expect($$('.notice--warn')).toHaveLength(1);
    expect($$('.notice--info')).toHaveLength(1);
  });
});

describe('ClipReview: phrases and the part to keep', () => {
  it('saves the edited phrases, and cannot save with every phrase hidden', () => {
    const m = mount();
    tickOwned();
    click(button(/Merge with next/));
    expect(container.textContent).toMatch(/2 phrases to practise/);
    click(saveButton());
    expect(m.saved[0].edits.phrases).toHaveLength(2);

    click(button(/Hide phrase/));
    click($$('.pe-item')[1]);
    click(button(/Hide phrase/));
    expect(blocked(saveButton())).toBe(true);
    expect(container.textContent).toMatch(/Show at least one phrase to practise/);
  });

  it('keeps the singing by default and lets the part be changed, widened to the whole file, or reset', () => {
    const m = mount();
    tickOwned();
    const hint = () => $$('.rev-section').find((s) => /Part to keep/.test(s.textContent ?? ''))!.textContent ?? '';
    expect(hint()).toMatch(/0:00\.\d to 0:2[01]\.\d of 0:22/);
    click(button(/Whole file/));
    expect(hint()).toMatch(/0:00\.0 to 0:22\.0/);
    click(saveButton());
    expect(m.saved[0].edits.trim).toEqual({ startSec: 0, endSec: 22 });

    click(button(/Start one second later/));
    click(button(/End one second earlier/));
    click(saveButton());
    expect(m.saved[1].edits.trim).toEqual({ startSec: 1, endSec: 21 });

    click(button(/Just the singing/));
    click(saveButton());
    expect(m.saved[2].edits.trim).toEqual({ startSec: 0, endSec: 21.5 });
  });

  it('says how many phrases a trim leaves out and refuses a trim with no phrase in it', () => {
    mount();
    tickOwned();
    click(button(/Whole file/));
    for (let i = 0; i < 9; i++) click(button(/Start one second later/));
    expect(container.textContent).toMatch(/1 phrase is outside this part and will be left out/);
    for (let i = 0; i < 12; i++) click(button(/Start one second later/));
    expect(blocked(saveButton())).toBe(true);
    expect(container.textContent).toMatch(/The part you chose to keep has no phrase in it/);
  });

  it('shows how much room the clip needs and warns when it is most of what is left', () => {
    mount({ storage: { usage: 5_900_000_000, quota: 5_900_300_000 } });
    expect(container.textContent).toMatch(/about .* on this device/);
    expect(container.textContent).toMatch(/most of the room left on this device/);
    act(() => root.unmount());
    root = createRoot(container);
    mount({ storage: { usage: 100, quota: 6_000_000_000 } });
    expect(container.textContent).not.toMatch(/most of the room left/);
  });
});

describe('ClipReview: listening', () => {
  it('plays the detected melody of the selected phrase as a tone, with Stop to end it', async () => {
    const m = mount();
    await clickAsync(button(/Hear the detected melody/));
    expect(m.player.calls).toHaveLength(1);
    const call = m.player.calls[0];
    const phrase = m.props.prepared.phrases[0];
    expect(call.rate).toBe(22050);
    expect(call.opts?.fromSec).toBeCloseTo(phrase.start, 6);
    expect(call.samples.length).toBe(Math.round((phrase.end - phrase.start) * 22050));
    let peak = 0;
    for (const v of call.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.2);
    expect(hasButton(/^Stop/)).toBe(true);
    click(button(/^Stop/));
    expect(m.player.stop).toHaveBeenCalled();
    expect(hasButton(/Hear the detected melody/)).toBe(true);
  });

  it('plays the original audio of the phrase, and goes back to idle when it ends', async () => {
    const m = mount();
    click($$('.pe-item')[1]);
    await clickAsync(button(/Hear the original/));
    const phrase = m.props.prepared.phrases[1];
    expect(m.player.calls[0].rate).toBe(8000);
    expect(m.player.calls[0].opts?.fromSec).toBeCloseTo(Math.floor(phrase.start * 8000) / 8000, 6);
    expect(m.player.calls[0].samples.length).toBeCloseTo((phrase.end - phrase.start) * 8000, -1);
    expect($$('button').filter((b) => /^Stop/.test(b.textContent ?? '')).length).toBeGreaterThan(0);
    act(() => m.player.finish());
    expect($$('button').filter((b) => /^Stop/.test(b.textContent ?? '')).length).toBe(0);
  });

  it('plays a phrase from the editor too, and says when the browser cannot play', async () => {
    const m = mount();
    m.player.playResult = false;
    await clickAsync(button(/Play phrase 1/));
    expect(container.textContent).toMatch(/could not play audio here.*silent switch/);
    expect(hasButton(/Play phrase 1/)).toBe(true);
  });

  it('stops the sound when another phrase is chosen and closes the audio when it goes away', async () => {
    const m = mount();
    await clickAsync(button(/Hear the original/));
    click($$('.pe-item')[2]);
    expect(m.player.stop).toHaveBeenCalled();
    act(() => root.unmount());
    expect(m.player.dispose).toHaveBeenCalled();
    root = createRoot(container);
  });

  it('records the verdict on the melody: yes keeps going, no on a solo clip reads it as a full song', async () => {
    const mixed = fakePrepared({ kind: 'mix', spans: [{ start: 2, end: 8 }, { start: 11, end: 18 }] });
    const reanalyze = vi.fn(async (_p: PreparedClip, _k: ClipKind) => mixed);
    mount({ reanalyze });
    click(button(/^Yes/));
    expect(container.textContent).toMatch(/Good\. The phrases below follow this line/);
    expect(button(/^Yes/).getAttribute('aria-pressed')).toBe('true');
    await clickAsync(button(/^No/));
    expect(reanalyze).toHaveBeenCalledTimes(1);
    expect(reanalyze.mock.calls[0][1]).toBe('mix');
    expect($<HTMLInputElement>('input[role="switch"]').checked).toBe(true);
  });

  it('on a full song, "no" points to the vocal-only file or another clip', () => {
    const mixed = fakePrepared({ kind: 'mix' });
    mount({ prepareStem: async () => fakePrepared() }, mixed);
    click(button(/^No/));
    expect(container.textContent).toMatch(/could not follow the singing in this song/);
    expect(container.textContent).toMatch(/Add the vocal-only file above/);
  });
});

describe('ClipReview: solo or full song', () => {
  it('reads the clip as a full song when the switch is turned on, and shows the new phrases', async () => {
    const mixed = fakePrepared({ kind: 'mix', spans: [{ start: 2, end: 9 }, { start: 12, end: 19 }], warnings: [MIX_REASON] });
    const reanalyze = vi.fn(async (_p: PreparedClip, _k: ClipKind, onProgress?: (p: never) => void) => {
      onProgress?.({ phase: 'analysing', fraction: 0.5 } as never);
      return mixed;
    });
    const m = mount({ reanalyze });
    click($$('.rev-chip input')[0]);
    expect($$('.rev-targets')).toHaveLength(1);
    expect($('input[role="switch"]').getAttribute('type')).toBe('checkbox');
    await clickAsync($('input[role="switch"]'));
    expect(reanalyze).toHaveBeenCalledWith(m.props.prepared, 'mix', expect.any(Function));
    expect(container.textContent).toMatch(/2 phrases to practise/);
    expect(container.textContent).toContain(MIX_REASON);
    expect($('input[role="switch"]').getAttribute('type')).toBe('checkbox');
    // Never offered for a full song.
    expect($$('.rev-targets')).toHaveLength(0);
    tickOwned();
    click(saveButton());
    expect(m.saved[0].edits).toMatchObject({ kind: 'mix', contributeToSinger: false });
    expect(m.saved[0].prepared).toBe(mixed);
    expect(preparedKind(m.saved[0].prepared)).toBe('mix');
  });

  it('shows progress while it reads and blocks saving until it is done', async () => {
    let finish!: (p: PreparedClip) => void;
    const reanalyze = vi.fn(() => new Promise<PreparedClip>((r) => (finish = r)));
    mount({ reanalyze, ownedDefault: true });
    await clickAsync($('input[role="switch"]'));
    expect($('.rev-busy').textContent).toMatch(/Following the lead vocal in the full song/);
    expect($('.rev-busy [role="progressbar"]')).toBeTruthy();
    expect(blocked(saveButton())).toBe(true);
    expect(blocked($<HTMLInputElement>('input[role="switch"]'))).toBe(true);
    await act(async () => finish(fakePrepared({ kind: 'mix' })));
    expect($$('.rev-busy')).toHaveLength(0);
  });

  it('asks before throwing away phrase edits, and keeps them if the user says so', async () => {
    const reanalyze = vi.fn(async () => fakePrepared({ kind: 'mix' }));
    mount({ reanalyze });
    click(button(/Merge with next/));
    await clickAsync($('input[role="switch"]'));
    expect(reanalyze).not.toHaveBeenCalled();
    expect($('[aria-label="Confirm changing how the clip is read"]').textContent).toMatch(/drops the changes you made/);
    click(button(/Keep my changes/));
    expect($$('[aria-label="Confirm changing how the clip is read"]')).toHaveLength(0);
    expect(container.textContent).toMatch(/2 phrases to practise/);
    await clickAsync($('input[role="switch"]'));
    await clickAsync(button(/Switch and re-detect/));
    expect(reanalyze).toHaveBeenCalledTimes(1);
    expect(container.textContent).toMatch(/3 phrases to practise/);
  });

  it('keeps the current reading and says what happened when the switch fails', async () => {
    const reanalyze = vi.fn(async () => {
      throw new Error('Mimic could not follow the song. Try the vocal-only file.');
    });
    mount({ reanalyze });
    await clickAsync($('input[role="switch"]'));
    expect(container.textContent).toMatch(/Mimic could not follow the song/);
    expect($<HTMLInputElement>('input[role="switch"]').checked).toBe(false);
    expect(container.textContent).toMatch(/3 phrases to practise/);
    click(button(/Dismiss message/));
    expect(container.textContent).not.toMatch(/Mimic could not follow the song/);
  });
});

describe('ClipReview: clips that cannot be used', () => {
  it('shows the reason and the way out, with no editor and Save disabled', () => {
    mount({}, fakePrepared({ name: 'talking.wav', blockers: [SPEECH_REASON] }));
    expect($('.notice--error').textContent).toContain(SPEECH_REASON);
    expect($('.notice--error').textContent).toMatch(/This clip cannot be used yet/);
    expect($$('.pe')).toHaveLength(0);
    expect($$('.rev-stats')).toHaveLength(0);
    expect(blocked(saveButton())).toBe(true);
    expect(container.textContent).toMatch(/Read the message above for what to do/);
    // The switch is still there: a voice over a band may read better as a full song.
    expect(blocked($<HTMLInputElement>('input[role="switch"]'))).toBe(false);
    expect(hasButton(/Hear the detected melody/)).toBe(false);
  });

  it('is not a dead end: a clip that cannot be used offers to choose a different file', () => {
    const onChooseOther = vi.fn();
    mount({ onChooseOther }, fakePrepared({ name: 'talking.wav', blockers: [SPEECH_REASON] }));
    click(button(/Choose a different file/));
    expect(onChooseOther).toHaveBeenCalledTimes(1);
  });

  it('only offers that when there is somewhere to go back to, and never on a clip that can be saved', () => {
    mount({}, fakePrepared({ blockers: [SPEECH_REASON] }));
    expect(hasButton(/Choose a different file/)).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    mount({ onChooseOther: vi.fn() });
    expect(hasButton(/Choose a different file/)).toBe(false);
  });

  it('says a silent clip is silent, and a very short one is too short, instead of blaming backing music', () => {
    const silent = littleSingingReason(0, { silent: true, durationSec: 10 });
    expect(silent).toMatch(/This clip is silent/);
    expect(silent).not.toMatch(/backing music/);
    const short = littleSingingReason(0.2, { durationSec: 0.4 });
    expect(short).toMatch(/only 0\.4 s long, too short/);
    expect(short).not.toMatch(/backing music/);
    expect(littleSingingReason(2, { durationSec: 10 })).toMatch(/backing music or effects/);
  });

  it('tells a full song with no followable lead vocal what to do, and still offers the vocal-only file', () => {
    const mixed = fakePrepared({ kind: 'mix', blockers: [littleMixSingingReason(0.4)] });
    mount({ prepareStem: async () => fakePrepared() }, mixed);
    expect($('.notice--error').textContent).toMatch(/could not follow a lead vocal/);
    expect($('.notice--error').textContent).toMatch(/vocal-only version/);
    expect(container.textContent).toMatch(/Have the vocal on its own/);
    expect(container.textContent).toMatch(/If you have this song's isolated vocal, add it here/);
    expect($('input[type="file"]').getAttribute('accept')).toContain('video/*');
  });
});

/** A prepared full song whose extractor reported this confidence. */
function mixWithConfidence(confidence: number, over: Parameters<typeof fakePrepared>[0] = {}): PreparedClip {
  const p = fakePrepared({ kind: 'mix', analysis: { mode: 'mix', issues: ['accompaniment'] }, warnings: [MIX_REASON], ...over });
  (p.analysis as VoiceAnalysis & { leadExtraction: { confidence: number; sideToMidDb: null } }).leadExtraction = { confidence, sideToMidDb: null };
  return p;
}

describe('ClipReview: the lead-vocal confidence of a full song', () => {
  it('shows a badge with the band in words and the number, and says it is a ranking', () => {
    mount({}, mixWithConfidence(0.91));
    const badge = $('.rev-lead');
    expect(badge.getAttribute('data-band')).toBe('high');
    expect(badge.textContent).toMatch(/Lead vocal: followed well/);
    expect(badge.textContent).toMatch(/0\.91 out of 1/);
    expect(badge.textContent).toMatch(/ranking, not a measured accuracy/);
  });

  it('labels each band honestly', () => {
    for (const [c, band, words] of [
      [0.84, 'ok', /followed fairly well/],
      [0.75, 'low', /hard to follow in places/],
      [0.5, 'poor', /very hard to follow/],
    ] as const) {
      act(() => root.unmount());
      root = createRoot(container);
      mount({}, mixWithConfidence(c));
      expect($('.rev-lead').getAttribute('data-band')).toBe(band);
      expect($('.rev-lead').textContent).toMatch(words);
    }
  });

  it('a rough guide (confidence high, a third or more of the line is the band) reads "hard to follow in places" and says what that means', () => {
    const p = mixWithConfidence(0.92);
    Object.assign((p.analysis as VoiceAnalysis & { leadExtraction: Record<string, unknown> }).leadExtraction, { noteTrust: Array(p.analysis.notes.length).fill(0.6), trustedNotes: p.analysis.notes.length * 0.6, purity: 0.6, roughGuide: true });
    mount({}, p);
    expect($('.rev-lead').getAttribute('data-band')).toBe('low');
    expect($('.rev-lead').textContent).toMatch(/hard to follow in places/);
    expect($('.rev-lead').textContent).toMatch(/third or more of what was followed is probably the band/);
  });

  it('is not shown for a solo clip, or once a vocal-only file stands in for the song', () => {
    mount();
    expect(container.querySelector('.rev-lead')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    const song = mixWithConfidence(0.6);
    const stemmed = { ...song, stem: fakePrepared({ name: 'vocals.wav' }) };
    mount({}, stemmed);
    expect(container.querySelector('.rev-lead')).toBeNull();
  });

  it('says a found band was followed automatically, and a manual choice was made by the user', () => {
    mount({}, mixWithConfidence(0.9));
    expect(container.textContent).toMatch(/Mimic found a band and followed the lead vocal/);
    act(() => root.unmount());
    root = createRoot(container);
    const manual = { ...mixWithConfidence(0.9), suggestedKind: 'solo' as const };
    mount({}, manual);
    expect(container.textContent).toMatch(/Singing with a band\. Mimic follows the lead vocal/);
  });

  it('shows the extractor\'s low-confidence warning among the notices', () => {
    mount({}, mixWithConfidence(0.65, { warnings: [MIX_REASON, 'The lead vocal was very hard to follow in this song, so treat the contour as a rough guide.'] }));
    expect($$('.notice--warn').map((n) => n.textContent).join(' ')).toMatch(/very hard to follow/);
  });

  it('never offers the one-tap singer targets for a full song', () => {
    mount({}, mixWithConfidence(0.95));
    click($$<HTMLInputElement>('input[type="radio"]')[0]);
    expect(container.textContent).not.toMatch(/targets/i);
  });
});

describe('ClipReview: the vocal-only file for a full song', () => {
  const mixed = () => fakePrepared({ kind: 'mix', blockers: [littleMixSingingReason(0.4)], name: 'Song.wav' });

  async function pickStem(file: File) {
    const input = $<HTMLInputElement>('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('attaches a matching stem, shows its phrases and saves it with the clip', async () => {
    const stem = fakePrepared({ name: 'Song (vocals).wav', spans: [{ start: 2, end: 8 }, { start: 10, end: 16 }] });
    const prepareStem = vi.fn(async () => stem);
    const m = mount({ prepareStem }, mixed());
    await pickStem(new File(['x'], 'Song (vocals).wav'));
    expect(prepareStem).toHaveBeenCalledTimes(1);
    expect($$('.notice--error')).toHaveLength(0);
    expect(container.textContent).toMatch(/Song \(vocals\)\.wav.* is used for the melody and phrases/);
    expect(container.textContent).toMatch(/2 phrases to practise/);
    tickOwned();
    click(saveButton());
    expect(m.saved[0].edits.kind).toBe('mix');
    expect(m.saved[0].edits.vocalStem).toBe(stem);
    // Removing it goes back to the full-song reading, which had no followable lead vocal.
    click(button(/Remove it/));
    expect($('.notice--error').textContent).toMatch(/could not follow a lead vocal/);
    expect(blocked(saveButton())).toBe(true);
  });

  it('refuses a stem of a different length and says so', async () => {
    const wrong = fakePrepared({ name: 'other.wav', durationSec: 40, spans: [{ start: 2, end: 8 }] });
    mount({ prepareStem: async () => wrong }, mixed());
    await pickStem(new File(['x'], 'other.wav'));
    expect(container.textContent).toMatch(/40\.0 s long but the song is 22\.0 s.*same length/);
    expect(container.textContent).not.toMatch(/is used for the melody/);
  });

  it('shows what went wrong when the stem cannot be read', async () => {
    mount({ prepareStem: async () => Promise.reject(new Error('"vocals.m4p" is copy-protected, so this app cannot read it.')) }, mixed());
    await pickStem(new File(['x'], 'vocals.m4p'));
    expect(container.textContent).toMatch(/copy-protected/);
  });

  it('is not offered for a solo clip or when the caller cannot read a second file', () => {
    mount({ prepareStem: async () => fakePrepared() });
    expect(container.textContent).not.toMatch(/Have the vocal on its own/);
    act(() => root.unmount());
    root = createRoot(container);
    mount({}, mixed());
    expect(container.textContent).not.toMatch(/Have the vocal on its own/);
  });
});
