// Trainer diagnostics: what this device really does, a checklist to run on the iPhone, and a report to send to us.
// Owner: W3 audio. Mount it from Settings -> Trainer (it brings its own heading) or as a page of its own.
//
// Nothing here records or keeps audio. The microphone checks run only when the person taps their button (iOS starts audio
// and asks for the microphone only inside a tap), and the report holds numbers and words, never recordings.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  DEVICE_CHECKLIST,
  DIAGNOSTIC_LABELS,
  QUICK_DIAGNOSTICS,
  formatDiagnostics,
  runDiagnostic as realRunDiagnostic,
  runQuickDiagnostics as realRunQuick,
  type ChecklistAnswer,
  type DiagnosticId,
  type DiagnosticProgress,
  type DiagnosticResult,
} from '../../audio/diagnostics';
import { usePwa } from '../../pwa/register';
import { saveFile } from '../components/download';
import { Icon, type IconName } from '../components/Icon';
import { Notice } from '../components/Notice';
import './trainerDiagnostics.css';

export interface DiagnosticsRunner {
  runDiagnostic: typeof realRunDiagnostic;
  runQuickDiagnostics: typeof realRunQuick;
}

const REAL: DiagnosticsRunner = { runDiagnostic: realRunDiagnostic, runQuickDiagnostics: realRunQuick };

const STATUS_WORDS: Record<DiagnosticResult['status'], string> = { ok: 'Good', warn: 'Check this', fail: 'Problem', info: 'Note' };
const STATUS_ICON: Record<DiagnosticResult['status'], IconName> = { ok: 'check', warn: 'alert', fail: 'alert', info: 'info' };

function StatusBadge({ status }: { status: DiagnosticResult['status'] }) {
  return (
    <span className={`td-status td-status--${status}`}>
      <Icon name={STATUS_ICON[status]} size={16} />
      {STATUS_WORDS[status]}
    </span>
  );
}

function ResultRow({ r, onAgain, disabled }: { r: DiagnosticResult; onAgain?: () => void; disabled?: boolean }) {
  const entries = Object.entries(r.details).filter(([k]) => !(r.sensitive ?? []).includes(k));
  return (
    <li className={`td-row td-row--${r.status}`}>
      <div className="td-row-head">
        <h3 className="td-row-title">{r.label}</h3>
        <StatusBadge status={r.status} />
      </div>
      <p className="td-row-summary">{r.summary}</p>
      {entries.length > 0 && (
        <details className="td-numbers">
          <summary>The numbers</summary>
          <dl>
            {entries.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="num">{v === null ? '-' : String(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {onAgain && (
        <button type="button" className="button button--ghost button--small" onClick={onAgain} disabled={disabled}>
          Run again
        </button>
      )}
    </li>
  );
}

type Busy = DiagnosticId | 'quick' | null;
type CopyState = 'idle' | 'copied' | 'failed' | 'shared' | 'saved';

export function TrainerDiagnostics({ runner = REAL }: { runner?: DiagnosticsRunner }) {
  const ids = useId();
  const pwa = usePwa();
  const [results, setResults] = useState<Partial<Record<DiagnosticId, DiagnosticResult>>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState<DiagnosticProgress | null>(null);
  const [checklist, setChecklist] = useState<Record<string, ChecklistAnswer>>({});
  const [notes, setNotes] = useState('');
  const [includeLabels, setIncludeLabels] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [previewOpen, setPreviewOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const put = useCallback((r: DiagnosticResult) => {
    if (alive.current) setResults((prev) => ({ ...prev, [r.id]: r }));
  }, []);

  // Each runner is started straight from the tap: iOS only starts audio and asks for the microphone inside one.
  const runQuick = () => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy('quick');
    setProgress(null);
    setCopyState('idle');
    void runner
      .runQuickDiagnostics({ signal: ctl.signal, onResult: put })
      .catch(() => undefined)
      .finally(() => {
        if (alive.current) setBusy(null);
      });
  };

  const runOne = (id: DiagnosticId) => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(id);
    setProgress({ fraction: 0 });
    setCopyState('idle');
    void runner
      .runDiagnostic(id, { signal: ctl.signal, onProgress: (p) => alive.current && setProgress(p) })
      .then(put)
      .catch(() => undefined)
      .finally(() => {
        if (alive.current) {
          setBusy(null);
          setProgress(null);
        }
      });
  };

  const stop = () => abortRef.current?.abort();

  const shown = useMemo(() => {
    const order: DiagnosticId[] = [...QUICK_DIAGNOSTICS, 'mic-level', 'click-probe'];
    return order.map((id) => results[id]).filter((r): r is DiagnosticResult => !!r);
  }, [results]);

  const report = useMemo(
    () => formatDiagnostics(shown, { appVersion: pwa.version ? `build ${pwa.version.slice(0, 7)}` : undefined, includeLabels, checklist, notes }),
    [shown, pwa.version, includeLabels, checklist, notes],
  );

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(report);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
      setPreviewOpen(true);
    }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = async () => {
    try {
      await navigator.share({ title: 'Mimic device report', text: report });
      setCopyState('shared');
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== 'AbortError') {
        setCopyState('failed');
        setPreviewOpen(true);
      }
    }
  };
  const save = async () => {
    await saveFile(new Blob([report], { type: 'text/plain' }), 'mimic-device-report.txt');
    setCopyState('saved');
  };

  const running = busy !== null;
  const answered = Object.keys(checklist).length;
  const mic = results['mic-level'];
  const click = results['click-probe'];

  return (
    <section className="td" aria-labelledby={`${ids}-h`}>
      <header className="td-head">
        <p className="eyebrow">Trainer</p>
        <h2 id={`${ids}-h`} className="section-title">
          Device check
        </h2>
        <p className="lede">
          These checks show what this phone does with sound, files and storage, so we can tune the Trainer for it. They take a few minutes. Nothing here records or keeps
          audio, and nothing is sent anywhere unless you send the report yourself.
        </p>
      </header>

      <div className="td-live" role="status" aria-live="polite">
        {busy === 'quick' && 'Running the quick checks…'}
        {busy && busy !== 'quick' && (progress?.message ?? 'Working…')}
        {!busy && copyState === 'copied' && 'Copied. Paste it into a message to us.'}
        {!busy && copyState === 'shared' && 'Shared.'}
        {!busy && copyState === 'saved' && 'Saved. Send us the file.'}
      </div>

      <section className="td-section" aria-labelledby={`${ids}-1`}>
        <h3 id={`${ids}-1`} className="td-step">
          <span className="td-num">1</span> Quick checks
        </h3>
        <p className="field-hint">No microphone and no sound. About ten seconds.</p>
        <div className="button-row">
          <button type="button" className="button button--accent" onClick={runQuick} disabled={running}>
            {busy === 'quick' ? 'Checking…' : shown.some((r) => (QUICK_DIAGNOSTICS as readonly string[]).includes(r.id)) ? 'Run the quick checks again' : 'Run the quick checks'}
          </button>
          {busy === 'quick' && (
            <button type="button" className="button button--ghost" onClick={stop}>
              Stop
            </button>
          )}
        </div>
        {shown.filter((r) => (QUICK_DIAGNOSTICS as readonly string[]).includes(r.id)).length === 0 && !running && (
          <p className="field-hint">Nothing has run yet. Tap the button above; each result appears here with what to do about it.</p>
        )}
        <ul className="td-list">
          {shown
            .filter((r) => (QUICK_DIAGNOSTICS as readonly string[]).includes(r.id))
            .map((r) => (
              <ResultRow key={r.id} r={r} />
            ))}
        </ul>
      </section>

      <section className="td-section" aria-labelledby={`${ids}-2`}>
        <h3 id={`${ids}-2`} className="td-step">
          <span className="td-num">2</span> Microphone and sound
        </h3>
        <p className="field-hint">Each test starts the microphone, so iOS asks for permission the first time. Tap the button, then follow the line that appears.</p>

        <div className="td-card">
          <h4 className="td-card-title">{DIAGNOSTIC_LABELS['mic-level']}</h4>
          <p className="field-hint">Sing or say “la la la” for about eight seconds, then stay quiet for the last two. It shows whether the level is right and the room is quiet enough.</p>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={() => runOne('mic-level')} disabled={running}>
              {busy === 'mic-level' ? 'Listening…' : mic ? 'Run it again' : 'Start the 10 second check'}
            </button>
            {busy === 'mic-level' && (
              <button type="button" className="button button--ghost" onClick={stop}>
                Stop
              </button>
            )}
          </div>
          {busy === 'mic-level' && (
            <div className="td-meter-wrap">
              <div className="td-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress?.level ?? 0) * 100)}>
                <div className="td-meter-bar" style={{ width: `${Math.round((progress?.level ?? 0) * 100)}%` }} />
              </div>
              <p className="td-meter-text">{progress?.message ?? 'Starting the microphone. Allow it if asked.'}</p>
              <div className="td-progress" role="progressbar" aria-label="Time left" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}>
                <div className="td-progress-bar" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
              </div>
            </div>
          )}
          {mic && busy !== 'mic-level' && (
            <ul className="td-list">
              <ResultRow r={mic} />
            </ul>
          )}
        </div>

        <div className="td-card">
          <h4 className="td-card-title">{DIAGNOSTIC_LABELS['click-probe']}</h4>
          <p className="field-hint">
            Plays four clicks and listens for them. With headphones on your head the microphone hears nothing, which is fine. To measure the delay, hold one earbud against the
            iPhone microphone first, or use the speaker.
          </p>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={() => runOne('click-probe')} disabled={running}>
              {busy === 'click-probe' ? 'Playing clicks…' : click ? 'Run it again' : 'Start the click test'}
            </button>
            {busy === 'click-probe' && (
              <button type="button" className="button button--ghost" onClick={stop}>
                Stop
              </button>
            )}
          </div>
          {busy === 'click-probe' && <p className="td-meter-text">{progress?.message ?? 'Starting the microphone. Allow it if asked.'}</p>}
          {click && busy !== 'click-probe' && (
            <ul className="td-list">
              <ResultRow r={click} />
            </ul>
          )}
        </div>
      </section>

      <section className="td-section" aria-labelledby={`${ids}-3`}>
        <h3 id={`${ids}-3`} className="td-step">
          <span className="td-num">3</span> On your iPhone
        </h3>
        <p className="field-hint">
          Things only a person holding the phone can find out. Do the ones you can; skip the rest. Answer after each one: it did what it says, it did not, or you skipped it.
          {answered > 0 ? ` ${answered} of ${DEVICE_CHECKLIST.length} answered.` : ''}
        </p>
        <ol className="td-checklist">
          {DEVICE_CHECKLIST.map((item) => (
            <li key={item.id}>
              <fieldset className="td-item">
                <legend>{item.title}</legend>
                {item.needs && <p className="td-needs">Needs: {item.needs}</p>}
                <ol className="td-steps-list">
                  {item.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p className="td-expect">
                  <strong>What should happen:</strong> {item.expect}
                </p>
                <div className="td-answers" role="radiogroup" aria-label={`Answer for ${item.title}`}>
                  {(
                    [
                      ['pass', 'It did'],
                      ['fail', 'It did not'],
                      ['skip', 'Skipped'],
                    ] as const
                  ).map(([value, text]) => (
                    <label key={value} className="td-answer">
                      <input
                        type="radio"
                        name={`${ids}-${item.id}`}
                        value={value}
                        checked={checklist[item.id] === value}
                        onChange={() => {
                          setChecklist((c) => ({ ...c, [item.id]: value }));
                          setCopyState('idle');
                        }}
                      />
                      <span>{text}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </li>
          ))}
        </ol>
      </section>

      <section className="td-section" aria-labelledby={`${ids}-4`}>
        <h3 id={`${ids}-4`} className="td-step">
          <span className="td-num">4</span> Send us the report
        </h3>
        <p className="field-hint">Numbers and words only: no audio and no recordings. Read it first if you like.</p>
        <div className="field">
          <label className="field-label" htmlFor={`${ids}-notes`}>
            Anything else we should know? (iPhone model, which headphones, what went wrong)
          </label>
          <textarea
            id={`${ids}-notes`}
            className="td-notes"
            rows={4}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setCopyState('idle');
            }}
          />
        </div>
        <label className="td-check">
          <input type="checkbox" checked={includeLabels} onChange={(e) => setIncludeLabels(e.target.checked)} />
          <span>Include the names of my microphones (a name like “Sam’s AirPods” can say who you are)</span>
        </label>
        <div className="button-row">
          <button type="button" className="button button--accent" onClick={() => void copy()}>
            <Icon name="file" size={18} /> Copy the report
          </button>
          {canShare && (
            <button type="button" className="button" onClick={() => void share()}>
              Share…
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={() => void save()}>
            <Icon name="download" size={18} /> Save as a file
          </button>
        </div>
        {copyState === 'failed' && (
          <Notice tone="warn" title="Could not copy by itself">
            Open “See the report” below, select all of it, copy it, and paste it into a message to us.
          </Notice>
        )}
        {shown.length === 0 && answered === 0 && <p className="field-hint">The report is nearly empty because nothing has run yet. Run the quick checks above first.</p>}
        <details className="td-preview" open={previewOpen} onToggle={(e) => setPreviewOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>See the report</summary>
          <pre className="td-report" tabIndex={0} aria-label="Report text">
            {report}
          </pre>
        </details>
      </section>
    </section>
  );
}

export function TrainerDiagnosticsPage(props: { runner?: DiagnosticsRunner }) {
  return (
    <div className="page page--diagnostics">
      <TrainerDiagnostics {...props} />
    </div>
  );
}
