// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FAKE_CLIP_ID, FAKE_NOW, makeFakeClip, makeFakeTrainerController, type FakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import type { ClipRecord } from '../../types';
import { analysisFromSpans } from '../../trainer/importTestKit';
import { ClipView } from './TrainerClip';

const analyze = vi.fn(async (_s: Float32Array, _sr: number, _o: unknown) => analysisFromSpans([{ start: 1, end: 5 }], 8));
vi.mock('../../analysis/client', () => ({ analyzeInWorker: (s: Float32Array, sr: number, o: unknown) => analyze(s, sr, o) }));

const screen = useScreen();

function clipPage(over: Partial<ClipRecord> = {}, ctl?: FakeTrainerController, id = FAKE_CLIP_ID) {
  const c = ctl ?? makeFakeTrainerController({ clips: [makeFakeClip(over)] });
  screen.mount(<ClipView clipId={id} now={FAKE_NOW} focusHeading={false} />, c);
  return c;
}
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('Clip detail', () => {
  it('names a phrase card with its length and range apart ("7.3 s, G3–E4"), not run together', () => {
    clipPage();
    const first = screen.qa<HTMLAnchorElement>('.cl-phrases > li > a')[0];
    expect(first.textContent).toMatch(/\d s · , [A-G]#?\d/); // the dot is aria-hidden; the comma is what is read
    expect(first.querySelector('.cp-meta .visually-hidden')?.textContent).toBe(', ');
    expect(first.textContent).not.toMatch(/\ds[A-G]/);
  });

  it('shows the title, the singer, how much is mastered and every phrase as a link in order', () => {
    clipPage();
    expect(screen.q('h1').textContent).toBe('Fake clip, 12 phrases');
    expect(screen.q('.cl-singer').textContent).toContain('Shawn Mendes');
    expect(screen.q('.cl-summary-main').textContent).toBe('4 of 12 mastered');
    expect(screen.q('.cl-summary-detail').textContent).toBe('3 to review · 6 learning · 1 stuck · 2 new');
    const rows = screen.qa<HTMLAnchorElement>('.cl-phrases > li > a');
    expect(rows).toHaveLength(12);
    expect(rows[0].getAttribute('href')).toBe('#trainer/c/fake-clip/p/1');
    expect(rows[11].getAttribute('href')).toBe('#trainer/c/fake-clip/p/12');
    expect(rows[0].textContent).toMatch(/Phrase 1.*6\.1 s.*G3–E4.*Review due.*best 99/s);
    expect(rows[9].textContent).toMatch(/Stuck/);
    expect(rows[10].textContent).toMatch(/New/);
    expect(rows[0].querySelector('svg.spark')?.getAttribute('aria-label')).toMatch(/^Last 5 scores: /);
    expect(screen.link(/All clips/).getAttribute('href')).toBe('#trainer');
  });

  it('draws the clip at a glance, one decorative block per phrase tinted by status, with the same news in words below', () => {
    clipPage();
    const bands = screen.qa('.cl-bands .cl-band');
    expect(bands).toHaveLength(12);
    expect(screen.q('.cl-bands').getAttribute('aria-hidden')).toBe('true');
    expect(bands.map((b) => b.className.replace('cl-band cl-band--', '').replace('cl-band', 'new'))).toEqual([
      'review-due',
      'review-due',
      'review-due',
      'mastered',
      'learning',
      'learning',
      'learning',
      'learning',
      'learning',
      'stuck',
      'new',
      'new',
    ]);
  });

  it('Practise in order starts at the first phrase that is not yet mastered', () => {
    clipPage();
    expect(screen.link(/Practise in order/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/1');
    const clip = makeFakeClip();
    const far = Date.parse('2027-01-01');
    clip.phrases = clip.phrases.map((p, i) => (i < 3 ? { ...p, srs: { ...p.srs, dueAt: far } } : p));
    clipPage({ phrases: clip.phrases });
    // Phrases 1 to 3 are mastered and not due, and so is 4: practice continues at the first one still being learned.
    expect(screen.link(/Continue from phrase 5/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/5');
  });

  it('collapses hidden short bits behind a button that counts them', () => {
    const clip = makeFakeClip();
    clipPage({ phrases: clip.phrases.map((p, i) => (i >= 10 ? { ...p, hidden: true } : p)) });
    expect(screen.qa('.cl-phrases').length).toBe(2);
    expect(screen.qa('.cl-phrases')[0].children).toHaveLength(10);
    expect(screen.q('.cl-hidden summary').textContent).toBe('Show 2 short bits');
    expect(screen.qa('.cl-phrases')[1].children).toHaveLength(2);
  });

  it('a clip with no visible phrases says what to do', () => {
    const clip = makeFakeClip();
    clipPage({ phrases: clip.phrases.map((p) => ({ ...p, hidden: true })) });
    expect(screen.text()).toMatch(/no visible phrases.*Edit phrases/);
    expect(screen.text()).toMatch(/no phrases to practise/);
  });

  it('says what a full song is and gives it no targets switch', () => {
    clipPage({ kind: 'mix', analysisKind: 'mix-melody' });
    expect(screen.text()).toMatch(/A full song/);
    expect(screen.text()).toMatch(/Full song \(pitch and timing only\)/);
    const sw = screen.q<HTMLInputElement>('input[role="switch"]');
    expect(sw.disabled).toBe(true);
    expect(screen.text()).toMatch(/A full song mix cannot set a singer's targets/);
  });
});

describe('Clip detail: a full song read by the lead-vocal extractor', () => {
  it('repeats how well the singing was followed when the clip was added, as a ranking', () => {
    clipPage({ kind: 'mix', analysisKind: 'mix-melody', analysis: { ...makeFakeClip().analysis, leadConfidence: 0.74 } });
    expect(screen.text()).toMatch(/followed the singing as hard to follow in places \(0\.74 out of 1, a ranking rather than a measured accuracy\)/);
    expect(screen.text()).toMatch(/Edit the phrases if the melody missed part of a line/);
  });

  it('says nothing about it for a clip stored before the rating existed, or one with a vocal-only file', () => {
    clipPage({ kind: 'mix', analysisKind: 'mix-melody' });
    expect(screen.text()).not.toMatch(/out of 1/);
  });
});

describe('Clip detail: renaming', () => {
  it('Rename opens a field with focus, Save changes the title, and focus goes back to the button', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Rename Fake clip/));
    const input = screen.q<HTMLInputElement>('.cl-rename input');
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Fake clip, 12 phrases');
    expect(input.getAttribute('maxlength')).toBe('120');
    type(input, '  Treat You Better, verse  ');
    await screen.clickAsync(screen.button('Save'));
    expect(ctl.calls).toContain('updateClip');
    expect(screen.q('h1').textContent).toBe('Treat You Better, verse');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.button(/Rename Treat You Better/));
    expect(screen.q('[role="status"].visually-hidden').textContent).toBe('Renamed.');
  });

  it('Enter saves, Escape cancels without saving', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Rename/));
    const input = screen.q<HTMLInputElement>('.cl-rename input');
    type(input, 'Something else');
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(screen.has('.cl-rename')).toBe(false);
    expect(screen.q('h1').textContent).toBe('Fake clip, 12 phrases');
    expect(ctl.calls).not.toContain('updateClip');
    screen.click(screen.button(/Rename/));
    type(screen.q<HTMLInputElement>('.cl-rename input'), 'Another name');
    await act(async () => void screen.q<HTMLFormElement>('.cl-rename').requestSubmit());
    await tick();
    expect(screen.q('h1').textContent).toBe('Another name');
  });

  it('an empty name is refused with a reason, and a name the library refuses is shown', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Rename/));
    type(screen.q<HTMLInputElement>('.cl-rename input'), '   ');
    await screen.clickAsync(screen.button('Save'));
    expect(screen.q('.notice--error').textContent).toBe('Give the clip a name.');
    expect(ctl.calls).not.toContain('updateClip');
    ctl.updateClip = async () => {
      throw new Error('The library is not open. Reload the app and try again.');
    };
    type(screen.q<HTMLInputElement>('.cl-rename input'), 'Fine name');
    await screen.clickAsync(screen.button('Save'));
    expect(screen.q('.notice--error').textContent).toMatch(/library is not open/);
  });

  it('keeping the same name just closes the field', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Rename/));
    await screen.clickAsync(screen.button('Save'));
    expect(screen.has('.cl-rename')).toBe(false);
    expect(ctl.calls).not.toContain('updateClip');
  });
});

describe('Clip detail: singer, targets, notes', () => {
  it('changing the singer is a toggle button, and Someone else asks for a name', async () => {
    const ctl = clipPage();
    const chip = (name: RegExp) => screen.qa<HTMLButtonElement>('.cl-singers .tr-chip').find((b) => name.test(b.textContent ?? ''))!;
    expect(chip(/Shawn/).getAttribute('aria-pressed')).toBe('true');
    await screen.clickAsync(chip(/Daniel/));
    expect(ctl.clips[0].singerId).toBe('daniel-caesar');
    expect(chip(/Daniel/).getAttribute('aria-pressed')).toBe('true');
    expect(screen.q('.cl-singer').textContent).toContain('Daniel Caesar');
    await screen.clickAsync(chip(/Someone else/));
    expect(ctl.clips[0].singerId).toBeNull();
    const name = screen.q<HTMLInputElement>('.cl-singers input');
    type(name, 'Alicia');
    act(() => {
      name.focus();
      name.blur();
    });
    await tick();
    expect(ctl.clips[0].singerLabel).toBe('Alicia');
    expect(screen.q('.cl-singer').textContent).toContain('Alicia');
  });

  it('the targets switch is a real switch that turns the clip\'s measurements on and off', async () => {
    const ctl = clipPage();
    const sw = screen.q<HTMLInputElement>('input[role="switch"]');
    expect(sw.checked).toBe(false);
    expect(sw.disabled).toBe(false);
    await screen.clickAsync(sw);
    expect(ctl.clips[0].contributesToSinger).toBe(true);
    expect(screen.text()).toMatch(/Its measurements shape Shawn Mendes's targets in the Studio\. 1 of 20 clips count\./);
    await screen.clickAsync(screen.q('input[role="switch"]'));
    expect(ctl.clips[0].contributesToSinger).toBe(false);
  });

  it('says why the switch is off: no singer chosen, or a clip that cannot be measured', () => {
    clipPage({ singerId: null, singerLabel: 'Alicia' });
    expect(screen.q<HTMLInputElement>('input[role="switch"]').disabled).toBe(true);
    expect(screen.text()).toContain('Choose which singer this clip is of first.');
    const clip = makeFakeClip();
    clipPage({ analysis: { ...clip.analysis, usableAsTarget: false, unusableReason: 'Only 2.1 s of clear singing could be heard in this clip.' } });
    expect(screen.text()).toContain('Only 2.1 s of clear singing');
  });

  it('shows a refusal from the library instead of failing quietly', async () => {
    const ctl = clipPage();
    ctl.setContributes = async () => {
      throw new Error('Singer targets are not available here.');
    };
    await screen.clickAsync(screen.q('input[role="switch"]'));
    expect(screen.q('.notice--error').textContent).toBe('Singer targets are not available here.');
  });

  it('saves notes when the field is left', async () => {
    const ctl = clipPage();
    const notes = screen.q<HTMLTextAreaElement>('textarea');
    type(notes, 'Listen for the breath before the chorus.');
    act(() => {
      notes.focus();
      notes.blur();
    });
    await tick();
    expect(ctl.clips[0].notes).toBe('Listen for the breath before the chorus.');
  });

  it('tells where the clip came from and that it stays on this device', () => {
    clipPage();
    expect(screen.text()).toMatch(/Added from fake-clip\.m4a\. You confirmed it is a file you own.*stays on this device/);
  });
});

describe('Clip detail: audio missing, not found, loading', () => {
  it('a clip restored from a backup says it needs the file, and Pick the file opens the sheet that reconnects it', async () => {
    clipPage({ audioMissing: true });
    expect(screen.text()).toMatch(/This clip needs its audio again/);
    expect(screen.has('a.cl-practise')).toBe(false);
    expect(screen.text()).toMatch(/Add the file again to practise/);
    await screen.clickAsync(screen.button(/Pick the file/));
    expect(document.querySelector('.imp-sheet')).not.toBeNull();
  });

  it('a clip that is not in the library says so and offers the way back', () => {
    clipPage({}, undefined, 'nope');
    expect(screen.q('h1').textContent).toBe('That clip is not in your library');
    expect(screen.link(/Back to the library/).getAttribute('href')).toBe('#trainer');
    expect(screen.link(/Add clips/).getAttribute('href')).toBe('#trainer/add');
  });

  it('while the library is opening it says so instead of "not found"', () => {
    clipPage({}, makeFakeTrainerController({ status: 'loading', clips: [] }), 'nope');
    expect(screen.q('h1').textContent).toBe('Opening your library…');
    expect(screen.has('a.button')).toBe(false);
  });

  it('takes focus on its heading when it is a new screen', () => {
    const c = makeFakeTrainerController({ clips: [makeFakeClip()] });
    screen.mount(<ClipView clipId={FAKE_CLIP_ID} now={FAKE_NOW} focusHeading />, c);
    expect(document.activeElement).toBe(screen.q('h1'));
  });
});

describe('Clip detail: editing phrases', () => {
  it('Edit phrases opens the editor with Save and Cancel, and Cancel changes nothing', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Edit phrases/));
    expect(screen.q('#cl-edit-h').textContent).toBe('Edit phrases');
    expect(screen.has('.pe-list, [aria-label="Phrases in this clip"]')).toBe(true);
    expect(screen.has('.cl-phrases')).toBe(false);
    await screen.clickAsync(screen.button(/^\s*Cancel/));
    expect(screen.has('.cl-phrases')).toBe(true);
    expect(ctl.calls).not.toContain('updatePhrases');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.button(/Edit phrases/));
  });

  it('moves focus to the editor heading when it opens, never to <body>', async () => {
    clipPage();
    const edit = screen.button(/Edit phrases/);
    edit.focus();
    screen.click(edit);
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.q('#cl-edit-h'));
    expect(screen.q('#cl-edit-h').getAttribute('tabindex')).toBe('-1');
  });

  it('a pressed control keeps focus while the change is saved (aria-disabled, not disabled)', async () => {
    const ctl = clipPage();
    let release: () => void = () => undefined;
    ctl.updateClip = () => new Promise<void>((r) => (release = r));
    const chip = screen.qa<HTMLButtonElement>('.tr-chip').find((b) => /Daniel/.test(b.textContent ?? ''))!;
    chip.focus();
    screen.click(chip);
    await tick();
    expect(chip.disabled).toBe(false);
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(chip);
    // Pressing again while it is busy does nothing.
    screen.click(screen.qa<HTMLButtonElement>('.tr-chip').find((b) => /Jalen/.test(b.textContent ?? ''))!);
    await act(async () => release());
  });

  it('saving without a change keeps every phrase and its history', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Edit phrases/));
    await screen.clickAsync(screen.button(/Save phrases/));
    expect(ctl.calls).toContain('updatePhrases');
    expect(ctl.calls).not.toContain('deleteAttempts');
    expect(ctl.clips[0].phrases).toHaveLength(12);
    expect(ctl.clips[0].phrases[4].stats.attempts).toBe(2);
    expect(screen.q('[role="status"].visually-hidden').textContent).toBe('Phrases saved.');
  });

  it('merging two phrases makes one new phrase with no history, and the old attempts are deleted', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Edit phrases/));
    screen.click(screen.button(/Merge with next/));
    await screen.clickAsync(screen.button(/Save phrases/));
    expect(ctl.clips[0].phrases).toHaveLength(11);
    expect(ctl.clips[0].phrases[0].stats.attempts).toBe(0);
    expect(ctl.calls.filter((c) => c === 'deleteAttempts')).toHaveLength(2);
    expect(screen.q('[role="status"].visually-hidden').textContent).toMatch(/2 changed phrases started fresh/);
    // Phrases 3 and 4 were mastered; the merged phrase starts fresh.
    expect(screen.q('.cl-summary-main').textContent).toBe('2 of 11 mastered');
  });
});

describe('Clip detail: deleting', () => {
  it('asks first, in the page, and Keep it backs out with focus on the delete button', async () => {
    const ctl = clipPage();
    screen.click(screen.button(/Delete clip/));
    const q = screen.q('.confirm');
    expect(q.textContent).toMatch(/Delete this clip, its phrases and every practice score from this device\? This cannot be undone\./);
    expect(document.activeElement?.textContent).toBe('Keep it');
    await screen.clickAsync(screen.button('Keep it'));
    expect(screen.has('.confirm')).toBe(false);
    expect(ctl.calls).not.toContain('deleteClip');
    await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(document.activeElement).toBe(screen.button(/Delete clip/));
  });

  it('Yes deletes the clip and goes to the library', async () => {
    const ctl = clipPage();
    window.location.hash = '#trainer/c/fake-clip';
    screen.click(screen.button(/Delete clip/));
    await screen.clickAsync(screen.button(/Yes, delete the clip/));
    expect(ctl.calls).toContain('deleteClip');
    expect(ctl.clips).toHaveLength(0);
    expect(window.location.hash).toBe('#trainer');
  });

  it('a failed delete says so and keeps the clip', async () => {
    const ctl = clipPage();
    ctl.deleteClip = async () => {
      throw new Error('The library is not open. Reload the app and try again.');
    };
    screen.click(screen.button(/Delete clip/));
    await screen.clickAsync(screen.button(/Yes, delete the clip/));
    expect(screen.q('.notice--error').textContent).toMatch(/not open/);
    expect(ctl.clips).toHaveLength(1);
  });
});


describe('Clip detail: the phrase editor shows the stored audio', () => {
  const SR = 8000;
  const reader = (over: Partial<{ source: 'mix' | 'vocal' }> = {}) =>
    vi.fn(async (_id: string) => ({ samples: new Float32Array(SR * 8).fill(0.2), sampleRate: SR, source: over.source ?? ('mix' as const) }));

  function withReader(read: ReturnType<typeof reader> | undefined, over: Partial<ClipRecord> = {}) {
    const ctl = makeFakeTrainerController({ clips: [makeFakeClip(over)] });
    if (read) ctl.readClipSamples = read;
    clipPage(over, ctl);
    return ctl;
  }

  it('reads the audio only while the editor is open, draws the waveform and the pitch line, and lets you hear a phrase', async () => {
    analyze.mockClear();
    const read = reader();
    withReader(read);
    expect(read).not.toHaveBeenCalled();
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect(read).toHaveBeenCalledWith(FAKE_CLIP_ID);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(screen.has('.pe-wave')).toBe(true);
    expect(screen.has('.pe-contour')).toBe(true);
    expect(screen.hasButton(/Play phrase 1/)).toBe(true);
    // Closing the editor lets go of the samples; opening it again reads them again.
    await screen.clickAsync(screen.button(/^\s*Cancel/));
    expect(screen.has('.pe-wave')).toBe(false);
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a song stored with its own vocal file is analysed from that file, and a song alone is analysed as a mix', async () => {
    analyze.mockClear();
    withReader(reader({ source: 'mix' }), { kind: 'mix', analysisKind: 'mix-melody' });
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect(analyze.mock.calls[0][2]).toMatchObject({ mode: 'mix' });
    screen.unmount();
    analyze.mockClear();
    withReader(reader({ source: 'vocal' }), { kind: 'mix', analysisKind: 'solo' });
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect((analyze.mock.calls[0][2] as { mode?: string }).mode).toBeUndefined();
  });

  it('says so and still lets you edit when the audio cannot be read', async () => {
    withReader(vi.fn(async () => Promise.reject(new Error('The chunks are gone.'))));
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect(screen.text()).toMatch(/The waveform could not be loaded \(The chunks are gone\.\)\. You can still edit the phrases with the buttons\./);
    expect(screen.has('.pe-wave')).toBe(false);
    expect(screen.hasButton(/Save phrases/)).toBe(true);
  });

  it('says it could not play when the browser has no audio, instead of doing nothing', async () => {
    withReader(reader());
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    await screen.clickAsync(screen.button(/Play phrase 1/));
    await tick(5);
    expect(screen.text()).toMatch(/This browser could not play audio here/);
  });

  it('without a way to read audio (a controller that cannot) the editor is the plain one', async () => {
    withReader(undefined);
    screen.click(screen.button(/Edit phrases/));
    await tick(20);
    expect(screen.text()).not.toMatch(/Loading the waveform/);
    expect(screen.has('.pe-wave')).toBe(false);
    expect(screen.hasButton(/Play phrase/)).toBe(false);
  });

  it('a clip whose audio is missing does not try to read it', async () => {
    const read = reader();
    withReader(read, { audioMissing: true });
    // The page offers the file again instead; the editor still opens for the phrases.
    const edit = screen.qa<HTMLButtonElement>('button').find((b) => /Edit phrases/.test(b.textContent ?? ''));
    if (edit && !edit.disabled) screen.click(edit);
    await tick(20);
    expect(read).not.toHaveBeenCalled();
  });
});
