// Settings, "Trainer": where the clips live and how much room they take, how a practice visit starts, whether to keep your
// recordings, a backup you can save and restore (never audio), the device checks, and a way to delete everything the Trainer
// holds. Renders nothing without a Trainer. Everything stays on this device.

import { useContext, useId, useRef, useState } from 'react';
import { formatBytes } from '../../pwa/storage';
import { parseSection } from '../../state/routing';
import { useTrainerExtras } from '../../state/TrainerProvider';
import { TrainerContext, type TrainerController } from '../../state/trainerContext';
import { Notice } from './Notice';
import { TrainerDiagnostics } from '../pages/TrainerDiagnostics';
import { downloadLibraryBackup } from '../pages/trainerKit';
import { COUNT_IN_CHOICES, SPEEDS, useTrainerPrefs, type StartMode } from '../trainerPrefs';
import { phraseCount } from './phraseStatus';

const START_MODES: { value: StartMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'sing-along', label: 'Always sing along' },
  { value: 'turn-taking', label: 'Always listen, then sing' },
];

function Pill(props: { tone?: 'good' | 'warn'; children: string }) {
  return <span className={`status-pill${props.tone ? ` status-pill--${props.tone}` : ''}`}>{props.children}</span>;
}

function Inner(props: { trainer: TrainerController }) {
  const { trainer } = props;
  const extras = useTrainerExtras();
  const [prefs, setPrefs] = useTrainerPrefs();
  const ids = { speed: useId(), count: useId(), start: useId(), file: useId() };
  const [backupNote, setBackupNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [importNote, setImportNote] = useState<{ ok: boolean; message: string; warnings: string[] } | null>(null);
  const [keepNote, setKeepNote] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDiag, setShowDiag] = useState(() => typeof window !== 'undefined' && parseSection(window.location.hash) === 'diagnostics');
  const clearButton = useRef<HTMLButtonElement>(null);
  const clearedNote = useRef<HTMLParagraphElement>(null);

  const { storage } = trainer;
  const phrases = trainer.clips.reduce((n, c) => n + c.phrases.filter((p) => !p.hidden).length, 0);
  const share = storage.usage !== null && storage.quota ? Math.min(1, storage.usage / storage.quota) : null;
  const ready = trainer.status === 'ready' || trainer.status === 'memory-only';

  const exportNow = async () => {
    setBusy(true);
    setBackupNote(await downloadLibraryBackup(trainer));
    setBusy(false);
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setImportNote(null);
    try {
      const r = await trainer.importLibrary(file);
      const bits = [r.added > 0 ? `${r.added} ${r.added === 1 ? 'clip' : 'clips'} added` : null, r.updated > 0 ? `${r.updated} updated` : null].filter(Boolean);
      setImportNote({
        ok: true,
        message: bits.length > 0 ? `Backup restored: ${bits.join(', ')}. Clips from a backup need their audio file added again before you can practise them.` : 'That backup holds nothing new, so nothing changed.',
        warnings: r.warnings,
      });
    } catch (err) {
      setImportNote({ ok: false, message: err instanceof Error && err.message ? err.message : 'That file could not be read as a Mimic backup. Pick a file saved from this screen.', warnings: [] });
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    setBusy(true);
    try {
      await trainer.clearAll();
      setCleared(true);
      setConfirmClear(false);
      requestAnimationFrame(() => clearedNote.current?.focus());
    } catch (err) {
      setImportNote({ ok: false, message: err instanceof Error && err.message ? err.message : 'The Trainer data could not be deleted. Reload the app and try again.', warnings: [] });
      setConfirmClear(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section st-trainer" aria-labelledby="trainer-heading">
      <h2 id="trainer-heading" className="section-title">
        Trainer
      </h2>
      <p className="settings-text">Your clips, phrases and practice scores are kept on this device only. A backup holds phrases and scores, never audio.</p>

      <h3 className="subhead">Storage</h3>
      <dl className="status-list">
        <div className="status-row">
          <dt>Library</dt>
          <dd>
            <span className="num">{trainer.clips.length}</span> {trainer.clips.length === 1 ? 'clip' : 'clips'}, {phraseCount(phrases)}
            {trainer.status === 'memory-only' && (
              <>
                {' '}
                <Pill tone="warn">Lost when you close the app</Pill>
              </>
            )}
          </dd>
        </div>
        <div className="status-row">
          <dt>Space used</dt>
          <dd>
            <span className="num">{storage.usage !== null ? formatBytes(storage.usage) : 'unknown'}</span>
            {storage.quota ? <span className="muted"> of about {formatBytes(storage.quota)}</span> : null}
            {share !== null && (
              <div className="st-meter" role="img" aria-label={`${Math.round(share * 100)} percent of the space this site may use`}>
                <span style={{ width: `${Math.max(1, Math.round(share * 100))}%` }} />
              </div>
            )}
          </dd>
        </div>
        <div className="status-row">
          <dt>Kept safe</dt>
          <dd>
            {storage.persisted === true ? <Pill tone="good">Persistent</Pill> : storage.persisted === false ? <Pill tone="warn">Best effort: the browser may clear it if space runs low</Pill> : <Pill>Unknown</Pill>}
          </dd>
        </div>
      </dl>
      {extras.storageNote && <p className="field-hint">{extras.storageNote}</p>}
      {storage.persisted === false && (
        <div className="button-row">
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void extras.requestPersistence().then(() => extras.refreshStorage())}
          >
            Ask the browser to keep my clips
          </button>
        </div>
      )}

      <h3 className="subhead">Practice</h3>
      <div className="field">
        <label className="field-label" htmlFor={ids.speed}>
          Starting speed
        </label>
        <select id={ids.speed} className="select" value={String(prefs.defaultRate)} onChange={(e) => setPrefs({ defaultRate: Number(e.currentTarget.value) })}>
          {SPEEDS.map((r) => (
            <option key={r} value={String(r)}>
              {Math.round(r * 100)}%{r === 0.5 ? ' (rough)' : ''}
            </option>
          ))}
        </select>
        <p className="field-hint">The speed a new phrase opens at. You can change it on the practice screen at any time.</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.count}>
          Count-in
        </label>
        <select id={ids.count} className="select" value={String(prefs.countInBeats)} onChange={(e) => setPrefs({ countInBeats: Number(e.currentTarget.value) })}>
          {COUNT_IN_CHOICES.map((n) => (
            <option key={n} value={String(n)}>
              {n} beats
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={ids.start}>
          How a practice visit starts
        </label>
        <select id={ids.start} className="select" value={prefs.startMode} onChange={(e) => setPrefs({ startMode: e.currentTarget.value as StartMode })}>
          {START_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="field-hint">Singing along with the guide through the speaker makes the microphone hear it too, so Automatic only sings along when headphones look connected. The microphone you record with is chosen above, under Your voice.</p>
      </div>
      <div className="field">
        <label className="tr-switch">
          <input
            type="checkbox"
            role="switch"
            checked={prefs.keepRecordings}
            onChange={(e) => {
              setPrefs({ keepRecordings: e.currentTarget.checked });
              setKeepNote(e.currentTarget.checked ? 'Recordings of your takes will be kept on this device, the last three per phrase.' : 'Recordings are no longer kept. Scores are still saved.');
            }}
          />
          <span className="tr-switch-label">Keep my recordings</span>
        </label>
        <p className="field-hint">Off by default. When on, the last three takes of each phrase stay on this device so you can play them back; they are never uploaded and a backup does not contain them.</p>
        <p className="visually-hidden" role="status">
          {keepNote}
        </p>
      </div>

      <h3 className="subhead">Backup</h3>
      <div className="button-row">
        <button type="button" className="button" onClick={() => void exportNow()} disabled={busy || !ready}>
          Export my library
        </button>
        <span className="tr-file">
          <input
            id={ids.file}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            disabled={busy || !ready}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void importFile(f);
            }}
          />
          <label htmlFor={ids.file} className="button button--ghost" aria-disabled={busy || !ready}>
            Import a backup
          </label>
        </span>
      </div>
      <p className="field-hint">Your clips, phrases and scores as a file you can keep. Importing merges: the newest copy of each clip wins, and clips come back without audio until you add the file again.</p>
      {backupNote && (
        <Notice tone={backupNote.ok ? 'info' : 'error'} onDismiss={() => setBackupNote(null)}>
          <p>{backupNote.message}</p>
        </Notice>
      )}
      {importNote && (
        <Notice tone={importNote.ok ? 'info' : 'error'} onDismiss={() => setImportNote(null)}>
          <p>{importNote.message}</p>
          {importNote.warnings.length > 0 && (
            <ul className="plain-list">
              {importNote.warnings.slice(0, 5).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <h3 className="subhead">Device checks</h3>
      <p className="settings-text">If listening, recording or timing misbehaves on your phone, these checks say what the device does and make a report you can send us.</p>
      <div className="button-row">
        <button type="button" className="button button--ghost" aria-expanded={showDiag} onClick={() => setShowDiag((v) => !v)}>
          {showDiag ? 'Hide the device checks' : 'Open the device checks'}
        </button>
      </div>
      {showDiag && (
        <div className="st-diag">
          <TrainerDiagnostics />
        </div>
      )}

      <h3 className="subhead">Delete Trainer data</h3>
      {!confirmClear ? (
        <button ref={clearButton} type="button" className="button button--danger" onClick={() => (setConfirmClear(true), setCleared(false))} disabled={busy}>
          Delete all clips and scores
        </button>
      ) : (
        <div className="confirm" role="group" aria-labelledby="trainer-clear-q">
          <p id="trainer-clear-q">
            Delete every clip, phrase, practice score and kept recording from this device? Clips that counted toward a singer&apos;s targets stop counting. Export a backup first if you want to keep your history.
            This cannot be undone.
          </p>
          <div className="button-row">
            <button type="button" className="button button--danger" onClick={() => void clearAll()} disabled={busy}>
              Yes, delete the Trainer data
            </button>
            <button
              type="button"
              className="button button--ghost"
              autoFocus
              onClick={() => {
                setConfirmClear(false);
                requestAnimationFrame(() => clearButton.current?.focus());
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p ref={clearedNote} className="field-hint" role="status" tabIndex={-1}>
        {cleared ? 'Trainer data deleted. Add a clip in the Trainer to start again.' : ''}
      </p>
    </section>
  );
}

export function TrainerSettings() {
  const trainer = useContext(TrainerContext);
  if (!trainer) return null;
  return <Inner trainer={trainer} />;
}
