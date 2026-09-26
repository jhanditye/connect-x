// Progress: trend charts per singer (overall and one chosen measure), the saved-session list with
// delete, and "Clear history" behind an in-page confirmation.

import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import { STYLE_LABELS } from '../../coach/profiles';
import type { SessionRecord, StyleKey } from '../../types';
import { DIM_DISPLAY, fmtSigned, singerVar } from '../charts/chartKit';
import { ProgressChart } from '../charts/ProgressChart';

const BUILTIN_ORDER = ['shawn-mendes', 'daniel-caesar', 'jalen-ngonda'];
const LIST_PAGE = 25;

interface ProfileTab {
  id: string;
  name: string;
  count: number;
}

/** One tab per profile that has sessions: builtin singers in their usual order, then others by name. */
export function profileTabs(sessions: readonly SessionRecord[]): ProfileTab[] {
  const byId = new Map<string, ProfileTab & { latest: number }>();
  for (const s of sessions) {
    const t = Date.parse(s.createdAt);
    const cur = byId.get(s.profileId);
    if (!cur) byId.set(s.profileId, { id: s.profileId, name: s.profileName || s.profileId, count: 1, latest: t });
    else {
      cur.count++;
      // The newest session's name wins (a reference profile may be renamed between takes).
      if (t > cur.latest && s.profileName) {
        cur.latest = t;
        cur.name = s.profileName;
      }
    }
  }
  const rank = (id: string) => {
    const i = BUILTIN_ORDER.indexOf(id);
    return i === -1 ? BUILTIN_ORDER.length : i;
  };
  return [...byId.values()]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    .map(({ id, name, count }) => ({ id, name, count }));
}

/** Style keys with at least one saved score among the sessions, in StyleVector order. */
export function availableMetrics(sessions: readonly SessionRecord[]): StyleKey[] {
  const present = new Set<string>();
  for (const s of sessions) for (const [k, v] of Object.entries(s.dimensionScores ?? {})) if (typeof v === 'number' && Number.isFinite(v)) present.add(k);
  return (Object.keys(DIM_DISPLAY) as StyleKey[]).filter((k) => present.has(k));
}

function metricLabel(k: StyleKey): string {
  return STYLE_LABELS[k]?.label ?? DIM_DISPLAY[k]?.name ?? k;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(t);
  } catch {
    return new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  }
}

function formatLength(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  if (sec < 60) return `${sec.toFixed(0)} s`;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function newestFirst(sessions: readonly SessionRecord[]): SessionRecord[] {
  return [...sessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function Stats(props: { sessions: SessionRecord[] }): JSX.Element | null {
  const list = [...props.sessions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (list.length === 0) return null;
  const first = list[0].overall;
  const latest = list[list.length - 1].overall;
  const best = Math.max(...list.map((s) => s.overall));
  const change = Math.round(latest) - Math.round(first);
  return (
    <dl className="hist-stats">
      <div>
        <dt>Takes</dt>
        <dd className="num">{list.length}</dd>
      </div>
      <div>
        <dt>Latest</dt>
        <dd className="num">{Math.round(latest)}</dd>
      </div>
      <div>
        <dt>Best</dt>
        <dd className="num">{Math.round(best)}</dd>
      </div>
      {list.length > 1 && (
        <div>
          <dt>Since first</dt>
          <dd className="num">{change === 0 ? '±0' : fmtSigned(change, 0)}</dd>
        </div>
      )}
    </dl>
  );
}

export function ProgressPage(props: { sessions: SessionRecord[]; onDelete: (id: string) => void; onClear: () => void }): JSX.Element {
  const { sessions, onDelete, onClear } = props;
  const tabs = useMemo(() => profileTabs(sessions), [sessions]);
  const sorted = useMemo(() => newestFirst(sessions), [sessions]);
  const [tab, setTab] = useState<string | null>(null);
  const [metric, setMetric] = useState<StyleKey | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [showAll, setShowAll] = useState(false);

  if (sessions.length === 0) {
    return (
      <div className="page page--progress">
        <header className="page-head">
          <p className="eyebrow">Progress</p>
          <h1 className="page-title">Your progress</h1>
        </header>
        <div className="hist-empty">
          <p>No saved takes yet.</p>
          <p className="muted">
            Record or upload a take in the <a href="#studio">Studio</a>, then press “Save to progress” on the Results page. Each saved take adds
            a point here, per singer, so you can see your mix and tone move toward the sound you are after. Only scores and measurements are
            saved, on this device; the audio is not.
          </p>
        </div>
      </div>
    );
  }

  // Default to the singer of the newest take.
  const activeId = tab && tabs.some((t) => t.id === tab) ? tab : (sorted[0]?.profileId ?? tabs[0]?.id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const forActive = sessions.filter((s) => s.profileId === active.id);
  const metrics = availableMetrics(forActive);
  const activeMetric = metric && metrics.includes(metric) ? metric : (metrics[0] ?? null);
  const visible = showAll ? sorted : sorted.slice(0, LIST_PAGE);

  return (
    <div className="page page--progress">
      <header className="page-head">
        <p className="eyebrow">Progress</p>
        <h1 className="page-title">Your progress</h1>
        <p className="lede">Scores are closeness to each singer’s target, so compare takes against the same singer and similar songs.</p>
      </header>

      <section className="hist-section" aria-labelledby="hist-trend" style={{ '--singer': singerVar(active.id) } as CSSProperties}>
        <h2 id="hist-trend" className="section-title">
          Trend
        </h2>
        {tabs.length > 1 && (
          <div className="hist-tabs" role="group" aria-label="Singer">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="hist-tab"
                aria-pressed={t.id === active.id}
                style={{ '--tab-color': singerVar(t.id) } as CSSProperties}
                onClick={() => setTab(t.id)}
              >
                <span className="hist-tab-dot" aria-hidden="true" />
                {t.name} <span className="hist-tab-count num">{t.count}</span>
              </button>
            ))}
          </div>
        )}
        <p className="hist-singer">
          Against <strong>{active.name}</strong>
        </p>
        <Stats sessions={forActive} />

        <h3 className="subhead">Overall match</h3>
        <ProgressChart sessions={sessions} profileId={active.id} metric="overall" />

        {metrics.length > 0 && activeMetric && (
          <>
            <div className="hist-metric">
              <label className="subhead" htmlFor="hist-metric-select">
                Measure
              </label>
              <select id="hist-metric-select" className="select" value={activeMetric} onChange={(e) => setMetric(e.target.value as StyleKey)}>
                {metrics.map((k) => (
                  <option key={k} value={k}>
                    {metricLabel(k)}
                  </option>
                ))}
              </select>
            </div>
            <ProgressChart sessions={sessions} profileId={active.id} metric={activeMetric} height={180} />
            <p className="caveat">The measure’s score is how close that one quality was to {active.name}’s target (100 = on target).</p>
          </>
        )}
      </section>

      <section className="hist-section" aria-labelledby="hist-list">
        <h2 id="hist-list" className="section-title">
          Saved takes
        </h2>
        <ol className="hist-list">
          {visible.map((s) => (
            <li key={s.id} className="hist-row" style={{ '--tab-color': singerVar(s.profileId) } as CSSProperties}>
              <div className="hist-row-main">
                <span className="hist-row-date">{formatWhen(s.createdAt)}</span>
                <span className="hist-row-meta">
                  <span className="hist-tab-dot" aria-hidden="true" />
                  {s.profileName}
                  <span className="num"> · {formatLength(s.durationSec)}</span>
                  {s.label ? <span className="hist-row-label"> · {s.label}</span> : null}
                </span>
              </div>
              <span className="hist-row-score num">
                <span className="visually-hidden">Overall match </span>
                {Math.round(s.overall)}
              </span>
              <button
                type="button"
                className="button button--ghost button--small hist-row-delete"
                onClick={() => onDelete(s.id)}
                aria-label={`Delete the ${s.profileName} take from ${formatWhen(s.createdAt)}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ol>
        {sorted.length > LIST_PAGE && (
          <button type="button" className="link-button hist-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${sorted.length} takes`}
          </button>
        )}

        <div className="hist-clear">
          {!confirming ? (
            <button type="button" className="button button--danger button--small" onClick={() => setConfirming(true)}>
              Clear history
            </button>
          ) : (
            <div className="confirm" role="group" aria-labelledby="hist-clear-q">
              <p id="hist-clear-q">
                Delete all {sessions.length} saved take{sessions.length === 1 ? '' : 's'}? This cannot be undone.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button--danger button--small"
                  onClick={() => {
                    setConfirming(false);
                    onClear();
                  }}
                >
                  Delete all
                </button>
                <button type="button" className="button button--ghost button--small" onClick={() => setConfirming(false)} autoFocus>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
