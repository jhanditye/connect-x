// Settings, "Trainer": where the clips live and how much room they take, how a practice visit starts, whether to keep your
// recordings, a backup you can save and restore (never audio), the device checks, and a way to delete everything the Trainer
// holds. Renders nothing without a Trainer. Everything stays on this device.

import { useContext, useId, useRef, useState, type KeyboardEvent } from 'react';
import { parseSection } from '../../state/routing';
import { TrainerContext, type TrainerController } from '../../state/trainerContext';
import { Notice } from './Notice';
import { TrainerDiagnostics } from '../pages/TrainerDiagnostics';
import { downloadLibraryBackup } from '../pages/trainerKit';
import { COUNT_IN_CHOICES, SPEEDS, useTrainerPrefs, type StartMode } from '../trainerPrefs';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import { deviceChecksLead, SPEAKER_ECHO_NOTE, tapVerb } from '../../pwa/words';

const START_MODES: { value: StartMode; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'sing-along', label: 'Always sing along' },
  { value: 'turn-taking', label: 'Always listen, then sing' },
];

function Inner(props: { trainer: TrainerController }) {
  const { trainer } = props;
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

  const ready = trainer.status === 'ready' || trainer.status === 'memory-only';

  // One message area per action: starting any backup, restore or delete clears what the last one said, so results never stack up.
  const exportNow = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setBackupNote(null);
    setImportNote(null);
    setBackupNote(await downloadLibraryBackup(trainer));
    setBusy(false);
  };

  const importFile = async (file: File) => {
    if (busy) return;
    setBusy(true);
    setBackupNote(null);
    setImportNote(null);
    try {
      const r = await trainer.importLibrary(file);
      const bits = [r.added > 0 ? `${r.added} ${r.added === 1 ? 'clip' : 'clips'} added` : null, r.updated > 0 ? `${r.updated} updated` : null].filter(Boolean);
      setImportNote({
        ok: true,
        message:
          bits.length > 0
            ? `Backup restored: ${bits.join(', ')}. A backup holds no audio, so open the Trainer and ${tapVerb(platformKind())} "Choose the files" to add the original audio files again. Mimic recognises each file by its contents and keeps your phrases and scores.`
            : 'That backup holds nothing new, so nothing changed.',
        warnings: r.warnings,
      });
    } catch (err) {
      setImportNote({ ok: false, message: err instanceof Error && err.message ? err.message : 'That file could not be read as a Mimic backup. Pick a file saved from this screen.', warnings: [] });
    } finally {
      setBusy(false);
    }
  };

  const cancelClear = () => {
    setConfirmClear(false);
    requestAnimationFrame(() => clearButton.current?.focus());
  };

  const clearAll = async () => {
    if (busy) return;
    setBusy(true);
    setBackupNote(null);
    setImportNote(null);
    try {
      await trainer.clearAll();
      setCleared(true);
      setConfirmClear(false);
      requestAnimationFrame(() => clearedNote.current?.focus());
    } catch (err) {
      setImportNote({ ok: false, message: err instanceof Error && err.message ? err.message : 'The clips and scores could not be deleted. Reload the app and try again.', warnings: [] });
      setConfirmClear(false);
      // The confirm buttons are gone: put focus back where the person started.
      requestAnimationFrame(() => clearButton.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section st-trainer" aria-labelledby="trainer-heading">
      <h2 id="trainer-heading" className="section-title">
        Trainer
      </h2>
      <p className="settings-text">
        Your clips, phrases and practice scores are kept on this device only. A backup holds phrases and scores, never audio. How much room they take, and whether
        the browser promises to keep them, is under Offline and storage below.
      </p>

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
        <p className="field-hint">Singing along with the guide through the speaker makes the microphone hear it too, so Automatic only sings along when headphones look connected. The microphone you record with is chosen above, under Your voice.{isDesktopKind(platformKind()) ? ` ${SPEAKER_ECHO_NOTE}` : ''}</p>
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
        <button type="button" className="button" onClick={() => void exportNow()} aria-disabled={busy || !ready || undefined} aria-busy={busy || undefined}>
          Export my library
        </button>
        <span className="tr-file">
          <input
            id={ids.file}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            disabled={!ready}
            // Not disabled while a restore runs: a focused control that disables drops keyboard focus to the page.
            onClick={(e) => {
              if (busy) e.preventDefault();
            }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void importFile(f);
            }}
          />
          <label
            htmlFor={ids.file}
            className="button button--ghost"
            aria-disabled={busy || !ready}
            onClick={(e) => {
              if (busy || !ready) e.preventDefault();
            }}
          >
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
          {importNote.ok && importNote.message.startsWith('Backup restored') && (
            <div className="button-row">
              <a className="button button--small" href="#trainer">
                Open the Trainer
              </a>
            </div>
          )}
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
      <p className="settings-text">{deviceChecksLead(platformKind())}</p>
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

      <h3 className="subhead">Delete clips and scores</h3>
      {!confirmClear ? (
        <button ref={clearButton} type="button" className="button button--danger" onClick={() => (setConfirmClear(true), setCleared(false))} aria-disabled={busy || undefined}>
          Delete clips and scores
        </button>
      ) : (
        <div
          className="confirm"
          role="group"
          aria-labelledby="trainer-clear-q"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Escape') cancelClear();
          }}
        >
          <p id="trainer-clear-q">
            Delete every clip, phrase, practice score and kept recording from this device? Clips that counted toward a singer&apos;s targets stop counting. Your settings,
            AI key and saved Studio takes stay. Export a backup first if you want to keep your history. This cannot be undone.
          </p>
          <div className="button-row">
            <button type="button" className="button button--danger" onClick={() => void clearAll()} aria-disabled={busy || undefined}>
              Yes, delete clips and scores
            </button>
            <button type="button" className="button button--ghost" autoFocus onClick={cancelClear}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p ref={clearedNote} className="field-hint" role="status" tabIndex={-1}>
        {cleared ? 'Clips and scores deleted. Add a clip in the Trainer to start again.' : ''}
      </p>
    </section>
  );
}

export function TrainerSettings() {
  const trainer = useContext(TrainerContext);
  if (!trainer) return null;
  return <Inner trainer={trainer} />;
}
