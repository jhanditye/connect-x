// Progress: trend charts per singer or reference clip (overall and one chosen measure), the
// saved-session list with delete, and deleting one take or the whole history behind in-page
// confirmations. After a delete, focus moves to the next row (or the list heading), never <body>.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent } from 'react';
import { STYLE_LABELS } from '../../coach/profiles';
import { isReferenceProfileId } from '../../storage/history';
import type { SessionRecord, StyleKey } from '../../types';
import { DIM_DISPLAY, fmtSigned, singerVar } from '../charts/chartKit';
import { hasScores, ProgressChart } from '../charts/ProgressChart';
import { PhraseProgress } from '../components/PhraseProgress';

const BUILTIN_ORDER = ['shawn-mendes', 'daniel-caesar', 'jalen-ngonda'];
const LIST_PAGE = 25;

interface ProfileTab {
  id: string;
  name: string;
  count: number;
}

/**
 * One tab per profileId that has sessions: builtin singers in their usual order, then the others
 * (reference clips, stored as 'reference:<clip name>') by name. Each tab is labelled with its
 * sessions' profileName.
 */
export function profileTabs(sessions: readonly SessionRecord[]): ProfileTab[] {
  const byId = new Map<string, ProfileTab & { latest: number }>();
  for (const s of sessions) {
    const t = Date.parse(s.createdAt);
    const cur = byId.get(s.profileId);
    if (!cur) byId.set(s.profileId, { id: s.profileId, name: s.profileName || s.profileId, count: 1, latest: t });
    else {
      cur.count++;
      // The newest session's name wins if a profile's display name ever changes.
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

/** Takes count every saved take; Latest, Best and Since first use only takes that were scored. */
function Stats(props: { sessions: SessionRecord[] }): JSX.Element | null {
  if (props.sessions.length === 0) return null;
  const list = props.sessions.filter(hasScores).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const unscored = props.sessions.length - list.length;
  const first = list[0]?.overall ?? NaN;
  const latest = list[list.length - 1]?.overall ?? NaN;
  const best = Math.max(...list.map((s) => s.overall));
  const change = Math.round(latest) - Math.round(first);
  return (
    <>
      <dl className="hist-stats">
        <div>
          <dt>Takes</dt>
          <dd className="num">{props.sessions.length}</dd>
        </div>
        {list.length > 0 && (
          <>
            <div>
              <dt>Latest</dt>
              <dd className="num">{Math.round(latest)}</dd>
            </div>
            <div>
              <dt>Best</dt>
              <dd className="num">{Math.round(best)}</dd>
            </div>
          </>
        )}
        {list.length > 1 && (
          <div>
            <dt>Since first</dt>
            <dd className="num">{change === 0 ? '±0' : fmtSigned(change, 0)}</dd>
          </div>
        )}
      </dl>
      {unscored > 0 && (
        <p className="caveat">
          {unscored === 1 ? 'One take' : `${unscored} takes`} had too little clear singing to score, so {unscored === 1 ? 'it is' : 'they are'} left out
          of the trend.
        </p>
      )}
    </>
  );
}

type FocusRequest = { kind: 'after-delete'; gone: string; next: string | null } | { kind: 'after-clear' } | { kind: 'clear-button' };

export function ProgressPage(props: { sessions: SessionRecord[]; onDelete: (id: string) => void; onClear: () => void }): JSX.Element {
  const { sessions, onDelete, onClear } = props;
  const tabs = useMemo(() => profileTabs(sessions), [sessions]);
  const sorted = useMemo(() => newestFirst(sessions), [sessions]);
  const [tab, setTab] = useState<string | null>(null);
  const [metric, setMetric] = useState<StyleKey | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<FocusRequest | null>(null);

  // Buttons that disappear (a deleted row, the confirm prompts) would drop focus to <body>, so move
  // it on purpose once the list has caught up with the change.
  useEffect(() => {
    const req = focusRequest.current;
    if (!req) return;
    let target: HTMLElement | null | undefined;
    if (req.kind === 'clear-button') target = clearButtonRef.current;
    else if (req.kind === 'after-clear') {
      if (sessions.length > 0) return;
      target = emptyRef.current;
    } else {
      if (sessions.some((s) => s.id === req.gone)) return;
      target = (req.next ? deleteButtons.current.get(req.next) : null) ?? (sessions.length > 0 ? listHeadingRef.current : emptyRef.current);
    }
    focusRequest.current = null;
    target?.focus();
  });

  if (sessions.length === 0) {
    return (
      <div className="page page--progress">
        <header className="page-head">
          <p className="eyebrow">Progress</p>
          <h1 className="page-title">Your progress</h1>
        </header>
        <div className="hist-empty">
          <p ref={emptyRef} tabIndex={-1} className="hist-empty-title">
            {cleared ? 'History cleared. No saved takes now.' : 'No saved takes yet.'}
          </p>
          <p className="muted">
            Record or upload a take in the <a href="#studio">Studio</a>, then press “Save to progress” on the Results page. Each saved take adds
            a point here, per singer, so you can see your mix and tone move toward the sound you are after. Only scores and measurements are
            saved, on this device; the audio is not.
          </p>
        </div>
        <PhraseProgress />
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
  const activeIsClip = isReferenceProfileId(active.id);

  const deleteTake = (id: string) => {
    const i = visible.findIndex((s) => s.id === id);
    const next = visible[i + 1] ?? visible[i - 1] ?? null;
    focusRequest.current = { kind: 'after-delete', gone: id, next: next?.id ?? null };
    setConfirmId(null);
    onDelete(id);
  };
  const keepTake = (id: string) => {
    setConfirmId(null);
    deleteButtons.current.get(id)?.focus();
  };
  const cancelClear = () => {
    focusRequest.current = { kind: 'clear-button' };
    setConfirming(false);
  };

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
                <span className="hist-tab-name" title={t.name}>
                  {t.name}
                </span> <span className="hist-tab-count num">{t.count}</span>
              </button>
            ))}
          </div>
        )}
        <p className="hist-singer">
          Against <strong className="hist-singer-name">{active.name}</strong>
          {activeIsClip ? ', your reference clip' : null}
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

      <PhraseProgress />

      <section className="hist-section" aria-labelledby="hist-list">
        <h2 id="hist-list" className="section-title" ref={listHeadingRef} tabIndex={-1}>
          Saved takes
        </h2>
        <ol className="hist-list">
          {visible.map((s) => {
            const scored = hasScores(s);
            const asking = confirmId === s.id;
            const when = formatWhen(s.createdAt);
            const promptId = `hist-del-${s.id}`;
            return (
              <li key={s.id} className="hist-row" style={{ '--tab-color': singerVar(s.profileId) } as CSSProperties}>
                <div className="hist-row-main">
                  <span className="hist-row-date">{when}</span>
                  <span className="hist-row-meta">
                    <span className="hist-tab-dot" aria-hidden="true" />
                    <span className="hist-row-name">{s.profileName}</span>
                    <span className="num"> · {formatLength(s.durationSec)}</span>
                    {s.label ? <span className="hist-row-label"> · {s.label}</span> : null}
                  </span>
                </div>
                <span className="hist-row-score num">
                  {scored ? (
                    <>
                      <span className="visually-hidden">Overall match </span>
                      {Math.round(s.overall)}
                    </>
                  ) : (
                    <>
                      <span className="visually-hidden">Not scored</span>
                      <span aria-hidden="true">–</span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  ref={(el) => {
                    if (el) deleteButtons.current.set(s.id, el);
                    else deleteButtons.current.delete(s.id);
                  }}
                  className="button button--ghost button--small hist-row-delete"
                  onClick={() => setConfirmId(asking ? null : s.id)}
                  aria-expanded={asking}
                  aria-label={`Delete the ${s.profileName} take from ${when}`}
                >
                  Delete
                </button>
                {asking && (
                  <div
                    className="confirm hist-row-confirm"
                    role="group"
                    aria-labelledby={promptId}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key === 'Escape') keepTake(s.id);
                    }}
                  >
                    <p id={promptId}>Delete this take? This cannot be undone.</p>
                    <div className="button-row">
                      <button type="button" className="button button--danger button--small" onClick={() => deleteTake(s.id)}>
                        Yes, delete
                      </button>
                      <button type="button" className="button button--ghost button--small" onClick={() => keepTake(s.id)} autoFocus>
                        Keep
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {sorted.length > LIST_PAGE && (
          <button type="button" className="link-button hist-more" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${sorted.length} takes`}
          </button>
        )}

        <div className="hist-clear">
          {!confirming ? (
            <button ref={clearButtonRef} type="button" className="button button--danger button--small" onClick={() => setConfirming(true)}>
              Clear history
            </button>
          ) : (
            <div
              className="confirm"
              role="group"
              aria-labelledby="hist-clear-q"
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Escape') cancelClear();
              }}
            >
              <p id="hist-clear-q">
                Delete all {sessions.length} saved take{sessions.length === 1 ? '' : 's'}? This cannot be undone.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="button button--danger button--small"
                  onClick={() => {
                    focusRequest.current = { kind: 'after-clear' };
                    setConfirming(false);
                    setCleared(true);
                    onClear();
                  }}
                >
                  Delete all
                </button>
                <button type="button" className="button button--ghost button--small" onClick={cancelClear} autoFocus>
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
