// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { attemptFromComparison, FAKE_NOW, makeFakeAttempts, makeFakeClip, makeFakePhraseComparison, makeFakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import { attemptsToSessions, dayKey, isDrawableAttempt, PhraseProgress, practiceDays, STREAK_DAYS } from './PhraseProgress';

const DAY = 86_400_000;

describe('practiceDays', () => {
  const at = (daysAgo: number) => ({ at: FAKE_NOW - daysAgo * DAY });

  it('is empty before anything is practised', () => {
    const d = practiceDays([], FAKE_NOW);
    expect(d.streak).toBe(0);
    expect(d.days).toHaveLength(STREAK_DAYS);
    expect(d.days.every((x) => !x.practised)).toBe(true);
  });

  it('counts consecutive days back from today, and the squares run oldest to newest', () => {
    const d = practiceDays([at(0), at(1), at(2), at(4)], FAKE_NOW);
    expect(d.streak).toBe(3);
    expect(d.days[STREAK_DAYS - 1].practised).toBe(true);
    expect(d.days[STREAK_DAYS - 4].practised).toBe(false);
    expect(d.days[STREAK_DAYS - 5].practised).toBe(true);
    expect(d.days[0].key < d.days[STREAK_DAYS - 1].key).toBe(true);
  });

  it('a streak that ended yesterday is still alive today', () => {
    expect(practiceDays([at(1), at(2)], FAKE_NOW).streak).toBe(2);
    expect(practiceDays([at(2), at(3)], FAKE_NOW).streak).toBe(0);
  });

  it('several attempts on one day are one day, and a streak can be longer than the squares', () => {
    expect(practiceDays([at(0), { at: FAKE_NOW - 60_000 }, { at: FAKE_NOW - 120_000 }], FAKE_NOW).streak).toBe(1);
    const long = Array.from({ length: 20 }, (_, i) => at(i));
    expect(practiceDays(long, FAKE_NOW).streak).toBe(20);
  });

  it('ignores a time that is not a number', () => {
    expect(practiceDays([{ at: Number.NaN }], FAKE_NOW).streak).toBe(0);
  });

  it('names a day by the local calendar', () => {
    expect(dayKey(new Date(2026, 9, 8, 23, 59).getTime())).toBe('2026-10-08');
    expect(dayKey(new Date(2026, 0, 2, 0, 1).getTime())).toBe('2026-01-02');
  });
});

describe('attemptsToSessions', () => {
  const clip = makeFakeClip();
  const phrase = clip.phrases[4];
  const all = makeFakeAttempts();

  it('turns one phrase\'s attempts into sessions, oldest first, with the score as the overall', () => {
    const s = attemptsToSessions(all, phrase, clip.title);
    expect(s).toHaveLength(2);
    expect(Date.parse(s[0].createdAt)).toBeLessThan(Date.parse(s[1].createdAt));
    expect(s.map((x) => x.overall)).toEqual(all.filter((a) => a.phraseId === phrase.id).sort((a, b) => a.at - b.at).map((a) => a.scores.overall));
    expect(s[0].profileId).toBe(`phrase:${phrase.id}`);
    expect(s[0].profileName).toBe('Fake clip, 12 phrases, Phrase 5');
    expect(s[0].label).toBe('100%');
    // The chart hides sessions that carry no dimension score.
    expect(Object.values(s[0].dimensionScores).some((v) => typeof v === 'number')).toBe(true);
  });

  it('leaves out other phrases and takes that could not be believed, and shows the speed of slow tries', () => {
    const bleed = { ...all.find((a) => a.phraseId === phrase.id)!, id: 'bleed', trust: 'invalid' as const };
    const slow = attemptFromComparison(makeFakePhraseComparison('flat'), { id: 'slow', clipId: clip.id, phraseId: phrase.id, at: FAKE_NOW, rate: 0.75 });
    const s = attemptsToSessions([...all, bleed, slow], phrase);
    expect(s.map((x) => x.id)).not.toContain('bleed');
    expect(s.find((x) => x.id === 'slow')?.label).toBe('75%');
    expect(s.every((x) => x.profileId === `phrase:${phrase.id}`)).toBe(true);
    expect(s[0].profileName).toBe('Phrase 5');
  });
});

describe('PhraseProgress', () => {
  const screen = useScreen();
  const mount = (opts: Parameters<typeof makeFakeTrainerController>[0] = {}) => screen.mount(<PhraseProgress now={FAKE_NOW} />, makeFakeTrainerController(opts));

  it('counts mastered, learning, new and to-review phrases, and shows a bar per clip', async () => {
    mount();
    await tick();
    expect(screen.q('#hist-phrases').textContent).toBe('Phrases');
    const counts = Object.fromEntries(screen.qa('.pp-counts > div').map((d) => [d.querySelector('dt')?.textContent, d.querySelector('dd')?.textContent]));
    expect(counts).toEqual({ Mastered: '4', Learning: '6', New: '2', 'To review': '3' });
    expect(screen.q('.pp-clip-head').textContent).toMatch(/Fake clip, 12 phrases.*4 of 12 mastered/);
    expect(screen.q('.pp-clip .cc-bar').getAttribute('aria-label')).toBe('4 of 12 phrases mastered, 6 in progress');
    expect(screen.q('.pp-clip-name').getAttribute('href')).toBe('#trainer/c/fake-clip');
  });

  it('shows the streak in words and as squares', async () => {
    const ctl = makeFakeTrainerController();
    screen.mount(<PhraseProgress now={FAKE_NOW} />, ctl);
    await tick();
    const expected = practiceDays(makeFakeAttempts(), FAKE_NOW);
    expect(screen.q('.pp-streak').textContent).toBe(`${expected.streak} days in a row.`);
    expect(screen.qa('.pp-day')).toHaveLength(STREAK_DAYS);
    expect(screen.qa('.pp-day--on')).toHaveLength(expected.days.filter((d) => d.practised).length);
    expect(screen.q('.pp-days').getAttribute('aria-label')).toMatch(/^The last 14 days: \d+ with practice$/);
  });

  it('charts one phrase over time, starting with the one practised last, and the pickers change it', async () => {
    mount();
    await tick();
    const phraseSelect = screen.qa<HTMLSelectElement>('select')[1];
    // Phrase 4 (four tries) was practised most recently; phrase 9 was tried once, six minutes earlier.
    expect(phraseSelect.selectedOptions[0].textContent).toBe('Phrase 4');
    expect(phraseSelect.options.length).toBe(10);
    expect(screen.q('svg[role="img"][aria-label]').getAttribute('aria-label')).toMatch(/^Overall match over 4 sessions/);
    await act(async () => {
      phraseSelect.value = 'fake-clip-p7';
      phraseSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(screen.q('svg[role="img"][aria-label]').getAttribute('aria-label')).toMatch(/one session/);
    expect(screen.link(/Practise this phrase/).getAttribute('href')).toBe('#trainer/c/fake-clip/p/7');
  });

  it('with clips but no attempts, says how to start', async () => {
    const clip = makeFakeClip();
    mount({ clips: [clip], attempts: [] });
    await tick();
    expect(screen.q('.pp-streak').textContent).toBe('No practice yet. Sing one phrase to start a streak.');
    expect(screen.text()).toMatch(/Sing a phrase in the Trainer and its scores will be charted here/);
    expect(screen.qa('select')).toHaveLength(0);
  });

  it('with no clips, names the next step', async () => {
    mount({ clips: [] });
    await tick();
    expect(screen.text()).toMatch(/No clips in the Trainer yet\./);
    expect(screen.link(/Add a clip/).getAttribute('href')).toBe('#trainer/add');
    expect(screen.has('.pp-counts')).toBe(false);
  });

  it('leaves out a stored try it cannot draw (a damaged row) instead of blanking the screen', async () => {
    const good = makeFakeAttempts();
    const damaged = { ...good[0], id: 'bad-time', at: 'yesterday' as unknown as number };
    const noScores = { ...good[0], id: 'bad-scores', scores: null as unknown as typeof good[0]['scores'] };
    const ctl = makeFakeTrainerController();
    ctl.listAttempts = async () => [damaged, noScores, ...good];
    screen.mount(<PhraseProgress now={FAKE_NOW} />, ctl);
    await tick();
    expect(screen.q('.pp-streak').textContent).toMatch(/days in a row/);
    expect(screen.has('svg[role="img"][aria-label]')).toBe(true);
    expect(isDrawableAttempt(damaged)).toBe(false);
    expect(isDrawableAttempt(noScores)).toBe(false);
    expect(isDrawableAttempt(good[0])).toBe(true);
  });

  it('shows nothing at all when there is no Trainer', () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const root = createRoot(holder);
    act(() => root.render(<PhraseProgress now={FAKE_NOW} />));
    expect(holder.innerHTML).toBe('');
    act(() => root.unmount());
    holder.remove();
  });
});
