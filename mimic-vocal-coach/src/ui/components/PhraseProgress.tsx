// Progress, "Phrases": how the phrases you practise in the Trainer are going. Counts (mastered, in progress, new), a bar per clip,
// a streak of days you practised, and the chart of one phrase's scores over time. Reads the Trainer's library and attempts; shows
// nothing at all when there is no Trainer, so the page works without it. The chart is the app's ProgressChart, fed with the
// phrase's attempts as if they were sessions.

import { useContext, useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { TrainerContext, type TrainerController } from '../../state/trainerContext';
import type { AttemptRecord, ClipRecord, PhraseRecord, SessionRecord } from '../../types';
import { ProgressChart } from '../charts/ProgressChart';
import { Icon } from './Icon';
import { phraseCount, summariseClip } from './phraseStatus';
import { clipColor } from './ClipCard';
import { ErrorBoundary } from './ErrorBoundary';

export const STREAK_DAYS = 14;

/** The local calendar day of a time, as "2026-10-08". */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface PracticeDays {
  /** Consecutive days with at least one attempt, counting back from today (or from yesterday while today is still to come). */
  streak: number;
  /** The last STREAK_DAYS days, oldest first, true where something was practised. */
  days: { key: string; practised: boolean }[];
}

/** The key of the local calendar day `k` days before `now`. Counted in calendar days, not 24 hours: a day with a clock change is 23 or 25 hours long. */
function dayKeyAgo(now: number, k: number): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // noon is never skipped or repeated by a clock change
  d.setDate(d.getDate() - k);
  return dayKey(d.getTime());
}

export function practiceDays(attempts: readonly Pick<AttemptRecord, 'at'>[], now: number): PracticeDays {
  const done = new Set(attempts.filter((a) => Number.isFinite(a.at)).map((a) => dayKey(a.at)));
  const days = Array.from({ length: STREAK_DAYS }, (_, i) => {
    const key = dayKeyAgo(now, STREAK_DAYS - 1 - i);
    return { key, practised: done.has(key) };
  });
  let streak = 0;
  // Today still counts as open until midnight: a streak that ended yesterday is alive.
  let i = days[days.length - 1].practised ? days.length - 1 : days.length - 2;
  for (; i >= 0 && days[i].practised; i--) streak++;
  if (i < 0) {
    // The run reached the oldest day shown (whether or not today is done yet): keep counting back beyond the window, day by day.
    let k = STREAK_DAYS;
    while (done.has(dayKeyAgo(now, k))) {
      streak++;
      k++;
    }
  }
  return { streak, days };
}

/** A stored attempt that can be drawn: a real time and a numeric overall score. Rows from a damaged or newer store are left out. */
export function isDrawableAttempt(a: unknown): a is AttemptRecord {
  const r = a as Partial<AttemptRecord> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    Number.isFinite(new Date(r.at).getTime()) &&
    typeof r.phraseId === 'string' &&
    !!r.scores &&
    typeof r.scores.overall === 'number' &&
    Number.isFinite(r.scores.overall)
  );
}

/**
 * One phrase's attempts as SessionRecords, so the app's ProgressChart can draw them. `overall` is the attempt's score. The chart
 * hides sessions that carry no dimension score, so the pitch score rides along in a style slot it does not otherwise use here.
 */
export function attemptsToSessions(attempts: readonly AttemptRecord[], phrase: Pick<PhraseRecord, 'id' | 'label'>, clipTitle = ''): SessionRecord[] {
  return attempts
    .filter((a) => a.phraseId === phrase.id && a.trust !== 'invalid')
    .map((a) => ({
      id: a.id,
      createdAt: new Date(a.at).toISOString(),
      profileId: `phrase:${phrase.id}`,
      profileName: clipTitle ? `${clipTitle}, ${phrase.label}` : phrase.label,
      overall: a.scores.overall,
      dimensionScores: { pitchAccuracyCents: a.scores.pitch },
      style: a.style,
      durationSec: 0,
      label: `${Math.round(a.rate * 100)}%`,
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function Inner(props: { trainer: TrainerController; now: number }) {
  const { trainer, now } = props;
  const ids = { clip: useId(), phrase: useId() };
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [clipId, setClipId] = useState<string | null>(null);
  const [phraseId, setPhraseId] = useState<string | null>(null);
  const clips = trainer.clips;

  const clipCount = clips.length;
  const listAttempts = trainer.listAttempts;
  useEffect(() => {
    if (clipCount === 0) {
      setAttempts([]);
      return;
    }
    let live = true;
    listAttempts({ limit: 2000 }).then(
      (list) => live && setAttempts(Array.isArray(list) ? list.filter(isDrawableAttempt) : []),
      () => live && setAttempts([]),
    );
    return () => {
      live = false;
    };
    // The attempts are read again when the library changes (a new attempt updates its phrase's stats).
  }, [listAttempts, clipCount, clips]);

  const totals = useMemo(() => {
    const t = { mastered: 0, learning: 0, fresh: 0, due: 0, total: 0 };
    for (const c of clips) {
      const s = summariseClip(c, now);
      t.mastered += s.mastered;
      t.learning += s.learning;
      t.fresh += s.fresh;
      t.due += s.reviewDue;
      t.total += s.total;
    }
    return t;
  }, [clips, now]);
  const days = useMemo(() => practiceDays(attempts, now), [attempts, now]);

  // The phrase for the chart: the one chosen, else the one practised most recently.
  const practised = useMemo(() => {
    const byPhrase = new Map<string, number>();
    for (const a of attempts) byPhrase.set(a.phraseId, Math.max(byPhrase.get(a.phraseId) ?? 0, a.at));
    return byPhrase;
  }, [attempts]);
  const clipsWithAttempts = clips.filter((c) => c.phrases.some((p) => practised.has(p.id)));
  const recentPhraseId = [...practised.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const recentClip = recentPhraseId ? clips.find((c) => c.phrases.some((p) => p.id === recentPhraseId)) : undefined;
  const activeClip: ClipRecord | undefined = clipsWithAttempts.find((c) => c.id === clipId) ?? recentClip ?? clipsWithAttempts[0];
  const phrases = activeClip ? activeClip.phrases.filter((p) => practised.has(p.id)) : [];
  const activePhrase: PhraseRecord | undefined = phrases.find((p) => p.id === phraseId) ?? phrases.find((p) => p.id === recentPhraseId) ?? phrases[0];
  const sessions = useMemo(() => (activePhrase ? attemptsToSessions(attempts, activePhrase, activeClip?.title) : []), [attempts, activePhrase, activeClip]);

  return (
    <section className="hist-section" aria-labelledby="hist-phrases">
      <h2 id="hist-phrases" className="section-title">
        Phrases
      </h2>
      {clips.length === 0 ? (
        <p className="muted">
          No clips in the Trainer yet. <a href="#trainer/add">Add a clip</a> and copy it phrase by phrase; mastered phrases, streaks and your score over time show up here.
        </p>
      ) : (
        <>
          <dl className="pp-counts">
            <div>
              <dt>Mastered</dt>
              <dd className="num">{totals.mastered}</dd>
            </div>
            <div>
              <dt>Learning</dt>
              <dd className="num">{totals.learning}</dd>
            </div>
            <div>
              <dt>New</dt>
              <dd className="num">{totals.fresh}</dd>
            </div>
            {totals.due > 0 && (
              <div>
                <dt>To review</dt>
                <dd className="num">{totals.due}</dd>
              </div>
            )}
          </dl>

          <ul className="pp-clips">
            {clips.map((c) => {
              const s = summariseClip(c, now);
              const style = { '--clip-color': clipColor(trainer.singers.find((x) => x.id === c.singerId)), '--done': `${s.total ? (s.mastered / s.total) * 100 : 0}%`, '--doing': `${s.total ? ((s.mastered + s.learning) / s.total) * 100 : 0}%` } as CSSProperties;
              return (
                <li key={c.id} className="pp-clip" style={style}>
                  <div className="pp-clip-head">
                    <a className="pp-clip-name" href={`#trainer/c/${encodeURIComponent(c.id)}`}>
                      {c.title}
                    </a>
                    <span className="pp-clip-n num">
                      {s.mastered} of {s.total} mastered
                    </span>
                  </div>
                  <span className="cc-bar" role="img" aria-label={`${s.mastered} of ${phraseCount(s.total)} mastered, ${s.learning} in progress`}>
                    <span className="cc-bar-doing" />
                    <span className="cc-bar-done" />
                  </span>
                </li>
              );
            })}
          </ul>

          <h3 className="subhead">Streak</h3>
          <p className="pp-streak">
            {days.streak > 0 ? (
              <>
                <strong className="num">{days.streak}</strong> {days.streak === 1 ? 'day' : 'days'} in a row.
              </>
            ) : attempts.length > 0 ? (
              'No practice today yet. Sing one phrase to start a streak.'
            ) : (
              'No practice yet. Sing one phrase to start a streak.'
            )}
          </p>
          <ul className="pp-days" aria-label={`The last ${STREAK_DAYS} days: ${days.days.filter((d) => d.practised).length} with practice`}>
            {days.days.map((d) => (
              <li key={d.key} className={`pp-day${d.practised ? ' pp-day--on' : ''}`} title={`${d.key}${d.practised ? ': practised' : ''}`} />
            ))}
          </ul>

          <h3 className="subhead">One phrase over time</h3>
          {activeClip && activePhrase ? (
            <>
              <div className="pp-pick">
                <div>
                  <label className="field-label" htmlFor={ids.clip}>
                    Clip
                  </label>
                  <select
                    id={ids.clip}
                    className="select"
                    value={activeClip.id}
                    onChange={(e) => {
                      setClipId(e.currentTarget.value);
                      setPhraseId(null);
                    }}
                  >
                    {clipsWithAttempts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field-label" htmlFor={ids.phrase}>
                    Phrase
                  </label>
                  <select id={ids.phrase} className="select" value={activePhrase.id} onChange={(e) => setPhraseId(e.currentTarget.value)}>
                    {phrases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label || `Phrase ${p.index + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <ErrorBoundary level="row" resetKey={activePhrase.id} rowLabel="The chart for this phrase could not be drawn. Its tries are still saved.">
                <ProgressChart sessions={sessions} profileId={`phrase:${activePhrase.id}`} metric="overall" height={180} />
              </ErrorBoundary>
              <p className="caveat">Each point is one try. A score is closeness to the original, not a rating of your singing; slow tries are included and are labelled with their speed.</p>
              <a className="button button--ghost button--small" href={`#trainer/c/${encodeURIComponent(activeClip.id)}/p/${activePhrase.index + 1}`}>
                <Icon name="play" size={14} /> Practise this phrase
              </a>
            </>
          ) : (
            <p className="muted">Sing a phrase in the Trainer and its scores will be charted here.</p>
          )}
        </>
      )}
    </section>
  );
}

/** The Phrases section. Renders nothing without a Trainer. `now` is for tests. */
export function PhraseProgress(props: { now?: number }) {
  const trainer = useContext(TrainerContext);
  if (!trainer) return null;
  return <Inner trainer={trainer} now={props.now ?? Date.now()} />;
}
