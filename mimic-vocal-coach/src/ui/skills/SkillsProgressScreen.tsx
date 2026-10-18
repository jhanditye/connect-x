// Skills progress: trend charts per measure, practice days and personal bests, the per-interval table (hearing and
// singing, up and down), the per-degree tuning profile ("your 7 tends to sit 20 cents flat"), held-note accuracy by
// register, and the latest sessions. Everything is read from the store; nothing here changes it.

import { useMemo, useState } from 'react';
import { midiToNoteName } from '../../dsp/music';
import { degreeProfile, degreeTendencies, intervalTable, METRIC_INFO, metricSeries, practiceDays, registerTable, sessionHeadline, SKILLS_METRICS, type DegreeRow, type IntervalRow } from '../../skills/progress/history';
import { formatCents } from '../../skills/score/format';
import { registerBands } from '../../skills/theory/range';
import { SCALE_MODE_LABELS, SCALE_MODES, SOLFEGE } from '../../skills/theory/scales';
import { STRICTNESS_CENTS, type CentsStat, type RateStat, type RegisterThird, type ScaleMode, type SkillsExerciseKind, type SkillsStore } from '../../skills/types';
import type { AppSettings } from '../../types';
import { formatMetric, MetricChart } from './kit/MetricChart';
import { rangeFor } from './kit/session';
import { BackToHub, FindingList, Segmented } from './kit/Widgets';
import { whenText } from './SkillsHub';
import './kit/skills-shell.css';
import { centsCount } from './sing/common';

const KIND_LABELS: Record<SkillsExerciseKind, string> = {
  'pitch-test': 'Pitch test',
  match: 'Match the note',
  ear: 'Ear training',
  'sing-intervals': 'Sing intervals',
  sequence: 'Scale-degree lines',
  breath: 'Breath',
  workout: 'Workout',
};
const REGISTER_LABELS: Record<RegisterThird, string> = { low: 'Low third', mid: 'Middle third', high: 'High third' };
/** The degree bars run from -50 to +50 cents (half a semitone each way); larger values are drawn at the edge. */
const BAR_CENTS = 50;

function rateCell(r: RateStat | null) {
  if (!r) return <span className="sk-dash">–</span>;
  return (
    <>
      <span className={`num ${r.ema >= 0.85 ? 'sk-good' : r.ema < 0.6 ? 'sk-work' : ''}`}>{Math.round(r.ema * 100)}%</span> <span className="sk-n">({r.n})</span>
    </>
  );
}

function singCell(c: CentsStat | null, tolerance: number) {
  if (!c) return <span className="sk-dash">–</span>;
  const word = Math.abs(c.emaSigned) < 5 ? '' : c.emaSigned > 0 ? ' wide' : ' narrow';
  return (
    <>
      <span className={`num ${c.emaAbs <= tolerance ? 'sk-good' : c.emaAbs > 50 ? 'sk-work' : ''}`}>{Math.round(c.emaAbs)}¢ off</span>
      <span className="sk-n">
        {word ? ` (${word.trim()})` : ''} ({c.n})
      </span>
    </>
  );
}

const hasIntervalData = (r: IntervalRow) => !!(r.hearUp || r.hearDown || r.hearHarmonic || r.singUp || r.singDown);

/** The modes that have any degree data, the preferred one first. */
export function modesWithDegreeData(store: SkillsStore): ScaleMode[] {
  const has = (m: ScaleMode) => degreeProfile(store.stats, m).some((r) => r.n > 0 || r.hearN > 0);
  const list = SCALE_MODES.filter(has);
  return list.length ? list : [store.prefs.scaleMode];
}

function DegreeBars(props: { rows: DegreeRow[]; mode: ScaleMode; toleranceCents: number }) {
  const pos = (c: number) => 50 + (Math.max(-BAR_CENTS, Math.min(BAR_CENTS, c)) / BAR_CENTS) * 50;
  const band = Math.min(BAR_CENTS, props.toleranceCents);
  return (
    <>
      <ul className="sk-bars" aria-label="Average tuning of each scale degree">
        {props.rows.map((r) => {
          const c = r.signedCents;
          const label = `${r.degree} (${SOLFEGE[props.mode][r.degree - 1]})`;
          const text = c === null ? 'not measured yet' : `${formatCents(c)} over ${r.n} ${r.n === 1 ? 'note' : 'notes'}`;
          return (
            <li key={r.degree} className="sk-bar-row" aria-label={`Degree ${label}: ${text}`}>
              <span className="sk-bar-label">
                {r.degree} <span className="sk-n">{SOLFEGE[props.mode][r.degree - 1]}</span>
              </span>
              <span className="sk-bar-track" aria-hidden="true">
                <span className="sk-bar-band" style={{ left: `${pos(-band)}%`, width: `${pos(band) - pos(-band)}%` }} />
                {c !== null && (
                  <span
                    className={`sk-bar-fill ${c < 0 ? 'sk-bar-fill--flat' : 'sk-bar-fill--sharp'}`}
                    style={{ left: `${Math.min(50, pos(c))}%`, width: `${Math.max(1, Math.abs(pos(c) - 50))}%` }}
                  />
                )}
              </span>
              <span className="sk-bar-value">{c === null ? '–' : `${formatCents(c)} (${r.n})`}</span>
            </li>
          );
        })}
      </ul>
      <p className="sk-bar-axis" aria-hidden="true">
        <span />
        <span>
          <span>flat −50</span>
          <span>0</span>
          <span>+50 sharp</span>
        </span>
        <span />
      </p>
    </>
  );
}

export function SkillsProgressScreen(props: { store: SkillsStore; settings: AppSettings; onExit(): void }) {
  const { store, settings } = props;
  const tolerance = STRICTNESS_CENTS[store.prefs.strictness] ?? STRICTNESS_CENTS.standard;
  const sessions = store.sessions;
  const real = sessions.filter((s) => s.kind !== 'workout');
  const days = practiceDays(sessions);
  const series = useMemo(() => SKILLS_METRICS.map((m) => ({ metric: m, info: METRIC_INFO[m], points: metricSeries(sessions, m) })), [sessions]);
  const withData = series.filter((s) => s.points.length > 0);
  const without = series.filter((s) => s.points.length === 0);
  const intervals = intervalTable(store.stats).filter(hasIntervalData);
  const modes = modesWithDegreeData(store);
  const [mode, setMode] = useState<ScaleMode>(() => (modes.includes(store.prefs.scaleMode) ? store.prefs.scaleMode : modes[0]));
  const degreeRows = degreeProfile(store.stats, mode);
  const tendencies = degreeTendencies(store.stats, mode);
  const registers = registerTable(store.stats);
  const bands = registerBands(rangeFor(settings, store.prefs));
  const recent = real.slice(-10).reverse();
  const bests = store.bests;

  return (
    <div className="sk-screen sk-progress">
      <header className="page-head">
        <BackToHub onExit={props.onExit} />
        <p className="eyebrow">Skills</p>
        <h1 className="page-title">Your Skills progress</h1>
        <p className="lede">How your fundamentals are moving over time. Recent sessions count most, so a habit you have fixed fades out of the averages.</p>
      </header>

      {real.length === 0 ? (
        <section className="sk-card">
          <p>Nothing here yet. Do the pitch test or today’s workout, and your numbers start to build up here.</p>
          <div className="button-row">
            <a className="button button--accent" href="#skills/pitch-test">
              Take the pitch test
            </a>
            <a className="button" href="#skills/workout">
              Today’s workout
            </a>
          </div>
        </section>
      ) : (
        <>
          <ul className="sk-stats-strip" aria-label="Practice days">
            <li>
              <strong>{real.length}</strong> {real.length === 1 ? 'session' : 'sessions'}
            </li>
            <li>
              <strong>{days.days}</strong> {days.days === 1 ? 'day' : 'days'} practised
            </li>
            {days.streak > 0 && (
              <li>
                Streak <strong>{days.streak}</strong> {days.streak === 1 ? 'day' : 'days'}
              </li>
            )}
            <li>
              <strong>{days.last7}</strong> this week
            </li>
          </ul>

          <section className="sk-section" aria-labelledby="sk-trends-h">
            <h2 id="sk-trends-h" className="section-title">
              Over time
            </h2>
            <p className="section-sub">One dot per session. 100 cents is a semitone; 25 cents is a quarter of one.</p>
            <div className="sk-chart-grid">
              {withData.map((s) => {
                const last = s.points[s.points.length - 1];
                return (
                  <article key={s.metric} className="sk-chart-card" data-metric={s.metric}>
                    <h3>{s.info.label}</h3>
                    <p className="sk-chart-latest">
                      Latest <strong className="num">{formatMetric(last.value, s.info.unit)}</strong> · {s.info.better === 'lower' ? 'lower' : 'higher'} is better
                    </p>
                    <MetricChart points={s.points} info={s.info} />
                  </article>
                );
              })}
            </div>
            {without.length > 0 && <p className="caveat">Not measured yet: {without.map((s) => s.info.label).join('; ')}.</p>}
          </section>

          <section className="sk-section" aria-labelledby="sk-bests-h">
            <h2 id="sk-bests-h" className="section-title">
              Personal bests
            </h2>
            <dl className="sk-bests">
              <div className="sk-best">
                <dt>Steady hiss</dt>
                <dd>{bests.hissSec ? `${bests.hissSec.value.toFixed(1)} s` : '–'}</dd>
              </div>
              <div className="sk-best">
                <dt>Long tone</dt>
                <dd>{bests.longToneSec ? `${bests.longToneSec.value.toFixed(1)} s` : '–'}</dd>
              </div>
              <div className="sk-best">
                <dt>Paced exhale</dt>
                <dd>{bests.pacedExhaleCounts ? `${Math.round(bests.pacedExhaleCounts.value)} counts` : '–'}</dd>
              </div>
            </dl>
            <p className="caveat">Longer is not the only goal: a steady, easy breath matters more than squeezing out the last of the air.</p>
          </section>

          <section className="sk-section" aria-labelledby="sk-degrees-h">
            <h2 id="sk-degrees-h" className="section-title">
              Your tuning on each scale degree
            </h2>
            <p className="section-sub">
              From your scale-degree lines: where each degree tends to sit against the key. The shaded band is your strictness ({tolerance} cents each way).
            </p>
            {modes.length > 1 && (
              <Segmented<ScaleMode> legend="Key" value={mode} options={modes.map((m) => ({ value: m, label: SCALE_MODE_LABELS[m] }))} onChange={setMode} />
            )}
            <FindingList findings={tendencies} />
            <DegreeBars rows={degreeRows} mode={mode} toleranceCents={tolerance} />
          </section>

          <section className="sk-section" aria-labelledby="sk-intervals-h">
            <h2 id="sk-intervals-h" className="section-title">
              Intervals
            </h2>
            <p className="section-sub">
              Heard: share named correctly (recent answers count most). Sung: how far the size of the jump was off; “wide” means too big, “narrow” too small.
              Numbers in brackets are how many times.
            </p>
            {intervals.length === 0 ? (
              <p className="muted">No intervals heard or sung yet.</p>
            ) : (
              <div className="sk-table-wrap">
                <table className="sk-table sk-interval-table">
                  <thead>
                    <tr>
                      <th scope="col">Interval</th>
                      <th scope="col">Heard up</th>
                      <th scope="col">Heard down</th>
                      <th scope="col">Heard together</th>
                      <th scope="col">Sung up</th>
                      <th scope="col">Sung down</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intervals.map((r) => (
                      <tr key={r.semitones}>
                        <th scope="row">
                          {r.short} <span className="sk-n">{r.name}</span>
                        </th>
                        <td>{rateCell(r.hearUp)}</td>
                        <td>{rateCell(r.hearDown)}</td>
                        <td>{rateCell(r.hearHarmonic)}</td>
                        <td>{singCell(r.singUp, tolerance)}</td>
                        <td>{singCell(r.singDown, tolerance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="sk-section" aria-labelledby="sk-reg-h">
            <h2 id="sk-reg-h" className="section-title">
              Held notes by register
            </h2>
            <p className="section-sub">From the pitch test and Match the note, across the thirds of your comfortable range.</p>
            <div className="sk-table-wrap">
              <table className="sk-table sk-register-table">
                <thead>
                  <tr>
                    <th scope="col">Register</th>
                    <th scope="col">Notes</th>
                    <th scope="col">Average error</th>
                    <th scope="col">Tends to sit</th>
                  </tr>
                </thead>
                <tbody>
                  {registers.map((r) => (
                    <tr key={r.register}>
                      <th scope="row">
                        {REGISTER_LABELS[r.register]}{' '}
                        <span className="sk-n">
                          {midiToNoteName(bands[r.register].lowMidi).replace('#', '♯')}–{midiToNoteName(bands[r.register].highMidi).replace('#', '♯')}
                        </span>
                      </th>
                      <td className="num">{r.n}</td>
                      <td className="num">{r.absCents === null ? '–' : `${centsCount(r.absCents)}`}</td>
                      <td>{r.signedCents === null ? '–' : Math.abs(r.signedCents) < 5 ? 'in the middle' : `${formatCents(r.signedCents)} (${r.signedCents > 0 ? 'sharp' : 'flat'})`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="sk-section" aria-labelledby="sk-recent-h">
            <h2 id="sk-recent-h" className="section-title">
              Latest sessions
            </h2>
            <ul className="sk-recent">
              {recent.map((s) => (
                <li key={s.id}>
                  <span>
                    <span className="sk-recent-kind">{KIND_LABELS[s.kind]}</span> · {sessionHeadline(s).text}
                  </span>
                  <span className="sk-recent-when">
                    {whenText(s.at)}
                    {s.workoutId ? ' · in a workout' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
