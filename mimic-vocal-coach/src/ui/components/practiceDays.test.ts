import { afterEach, describe, expect, it } from 'vitest';
import { exportFileName } from '../../storage/library';
import { dayKey, practiceDays, STREAK_DAYS } from './PhraseProgress';

// Days are calendar days in the person's own time zone, not 24-hour steps: a day with a clock change is 23 or 25 hours long.
// These run in America/Los_Angeles (the clocks changed on 2026-03-08 and 2026-11-01); they are skipped where the runtime cannot switch zones.

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function useLosAngeles(): boolean {
  process.env.TZ = 'America/Los_Angeles';
  return new Date(2026, 6, 1, 12).getTimezoneOffset() === 420 && new Date(2026, 0, 1, 12).getTimezoneOffset() === 480;
}

const local = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const DAY = 86_400_000;

describe('practiceDays across a clock change', () => {
  it('spring forward: opened at 00:30 on 9 March after practising on the 7th and 8th, the 8th is not skipped', () => {
    if (!useLosAngeles()) return;
    const attempts = [{ at: local(2026, 3, 7, 20) }, { at: local(2026, 3, 8, 20) }];
    const d = practiceDays(attempts, local(2026, 3, 9, 0, 30));
    expect(d.days.slice(-5).map((x) => [x.key, x.practised])).toEqual([
      ['2026-03-05', false],
      ['2026-03-06', false],
      ['2026-03-07', true],
      ['2026-03-08', true],
      ['2026-03-09', false],
    ]);
    expect(d.streak).toBe(2);
  });

  it('fall back: opened at 23:45 on 1 November, no day is shown twice and the streak is right', () => {
    if (!useLosAngeles()) return;
    const attempts = [{ at: local(2026, 10, 31, 20) }, { at: local(2026, 11, 1, 9) }];
    const d = practiceDays(attempts, local(2026, 11, 1, 23, 45));
    const keys = d.days.map((x) => x.key);
    expect(new Set(keys).size).toBe(STREAK_DAYS);
    expect(keys.slice(-3)).toEqual(['2026-10-31', '2026-11-01'].length ? ['2026-10-30', '2026-10-31', '2026-11-01'] : []);
    expect(d.streak).toBe(2);
  });

  it('a daily 20:00 practiser keeps the right streak whatever hour the app is opened, for two weeks on either side of both changes', () => {
    if (!useLosAngeles()) return;
    for (const [from, to] of [
      [local(2026, 3, 1), local(2026, 3, 20)],
      [local(2026, 10, 25), local(2026, 11, 15)],
    ]) {
      const first = new Date(from);
      first.setDate(first.getDate() - 30);
      // Practice at 20:00 on every day from 30 days before the window up to the day before it ends.
      const attempts: { at: number }[] = [];
      for (const day = new Date(first); day.getTime() <= to; day.setDate(day.getDate() + 1)) attempts.push({ at: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 20).getTime() });
      for (let t = from; t <= to; t += 3_600_000) {
        const now = new Date(t);
        const practisedToday = now.getHours() >= 20;
        const daysSinceFirst = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime() - new Date(first.getFullYear(), first.getMonth(), first.getDate(), 12).getTime()) / DAY);
        const expected = daysSinceFirst + (practisedToday ? 1 : 0);
        const seen = attempts.filter((a) => a.at <= t);
        expect(practiceDays(seen, t).streak, now.toString()).toBe(expected);
      }
    }
  });

  it('names the backup file for the local day, not the UTC day', () => {
    if (!useLosAngeles()) return;
    expect(exportFileName(new Date(2026, 9, 8, 21, 30))).toBe('mimic-library-2026-10-08.json');
    expect(exportFileName(new Date(2026, 2, 8, 23, 59))).toBe('mimic-library-2026-03-08.json');
    expect(exportFileName(new Date(2026, 0, 2, 0, 5))).toBe('mimic-library-2026-01-02.json');
    expect(dayKey(new Date(2026, 9, 8, 21, 30).getTime())).toBe('2026-10-08');
  });
});

describe('practiceDays: streaks longer than the squares', () => {
  const at = (daysAgo: number, now: number) => ({ at: now - daysAgo * DAY });
  const NOW = local(2026, 6, 15, 10);

  it('keeps counting past the window while today is still to come (a 14, 20 or 30 day streak is not shown as 13)', () => {
    for (const n of [13, 14, 20, 30]) {
      const attempts = Array.from({ length: n }, (_, i) => at(i + 1, NOW)); // yesterday and the n-1 days before it; nothing today
      expect(practiceDays(attempts, NOW).streak, `${n} days`).toBe(n);
      expect(practiceDays([...attempts, at(0, NOW)], NOW).streak, `${n} days and today`).toBe(n + 1);
    }
  });

  it('stops at the first gap, inside or beyond the window', () => {
    const gapBeyond = [...Array.from({ length: 14 }, (_, i) => at(i + 1, NOW)), ...Array.from({ length: 5 }, (_, i) => at(i + 16, NOW))];
    expect(practiceDays(gapBeyond, NOW).streak).toBe(14);
    const gapInside = [...Array.from({ length: 5 }, (_, i) => at(i + 1, NOW)), ...Array.from({ length: 9 }, (_, i) => at(i + 7, NOW))];
    expect(practiceDays(gapInside, NOW).streak).toBe(5);
  });

  it('a streak that ended the day before yesterday is over', () => {
    expect(practiceDays(Array.from({ length: 20 }, (_, i) => at(i + 2, NOW)), NOW).streak).toBe(0);
  });
});
