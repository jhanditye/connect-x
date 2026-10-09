// Trainer: phrase-by-phrase mimicry of clips the user adds. This page picks the sub-view from the URL (useTrainerPath):
//   #trainer                    the library: today's queue, clips grouped by singer, Add clips
//   #trainer/add                the library with the Add clips sheet open
//   #trainer/c/<id>             one clip and its phrases        (TrainerClip.tsx)
//   #trainer/c/<id>/p/<n>       the practice screen for phrase n (TrainerPractice.tsx)
// Everything here codes against the TrainerController (useTrainer) and, for practice, the PracticeEngine it hands out, so the
// screens work with the fakes in testing/trainerFixtures.ts as well as with the real modules.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { looksLikeMedia } from '../../audio/decode';
import { useTrainer } from '../../state/trainerContext';
import { useTrainerExtras } from '../../state/TrainerProvider';
import { goTrainer, trainerHash, useTrainerPath } from '../../state/routing';
import type { QueueItem } from '../../trainer/srs';
import type { ClipRecord, PhraseRecord } from '../../types';
import { ClipCard, clipColor } from '../components/ClipCard';
import { Icon } from '../components/Icon';
import { ImportSheet } from '../components/ImportSheet';
import { InstallCard } from '../components/InstallCard';
import { Notice } from '../components/Notice';
import { StatusChip } from '../components/StatusChip';
import { TrainerEmpty } from '../components/TrainerEmpty';
import { formatBytes } from '../../pwa/storage';
import { phraseNumber } from '../components/phraseStatus';
import { clearPendingImport, peekPendingImport, setPendingImport } from '../trainerHandoff';
import { ClipView } from './TrainerClip';
import { PracticeView } from './TrainerPractice';
import { downloadLibraryBackup, groupClips, useFocusOnMount } from './trainerKit';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import { desktopMemoryOnlyAdvice } from '../../pwa/words';

const TODAY_SHOWN = 3;

interface QueueEntry {
  item: QueueItem;
  clip: ClipRecord;
  phrase: PhraseRecord;
}

function resolveQueue(queue: readonly QueueItem[], clips: readonly ClipRecord[]): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const item of queue) {
    for (const clip of clips) {
      const phrase = clip.phrases.find((p) => p.id === item.phraseId);
      if (phrase) {
        out.push({ item, clip, phrase });
        break;
      }
    }
  }
  return out;
}

function Today(props: { entries: QueueEntry[] }) {
  const { entries } = props;
  const shown = entries.slice(0, TODAY_SHOWN);
  const first = entries[0];
  return (
    <section className="tr-today" aria-labelledby="tr-today-h">
      <div className="section-head">
        <h2 id="tr-today-h" className="section-title">
          Today
        </h2>
        <p className="section-sub">
          {entries.length} {entries.length === 1 ? 'phrase is' : 'phrases are'} worth your time now.
        </p>
      </div>
      {first && (
        <a className="button button--accent tr-start" href={trainerHash({ view: 'phrase', clipId: first.clip.id, phraseNumber: phraseNumber(first.phrase) })}>
          <Icon name="play" size={14} /> Start with the first
        </a>
      )}
      <ul className="tr-queue">
        {shown.map(({ item, clip, phrase }) => (
          <li key={item.phraseId}>
            <a className="tq" href={trainerHash({ view: 'phrase', clipId: clip.id, phraseNumber: phraseNumber(phrase) })}>
              <span className="tq-main">
                <span className="tq-title">{clip.title}</span>
                <span className="tq-phrase">
                  Phrase <span className="num">{phraseNumber(phrase)}</span>
                  {phrase.label && phrase.label !== `Phrase ${phraseNumber(phrase)}` ? `, ${phrase.label}` : ''}
                </span>
                <span className="tq-reason">{item.reason}</span>
              </span>
              <StatusChip status={item.status} />
              <Icon name="forward" size={18} className="tq-go" />
            </a>
          </li>
        ))}
      </ul>
      {entries.length > shown.length && (
        <p className="tr-more">
          and {entries.length - shown.length} more after these.
        </p>
      )}
    </section>
  );
}

function LibraryView(props: { now: number; adding: boolean; focusHeading: boolean }) {
  const trainer = useTrainer();
  const extras = useTrainerExtras();
  const headingRef = useFocusOnMount<HTMLHeadingElement>(props.focusHeading);
  const [filter, setFilter] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [backupNote, setBackupNote] = useState<{ ok: boolean; message: string } | null>(null);
  const dragDepth = useRef(0);
  // The floating Add clips button covered the second queue card at first view, so the page has its own Add clips button under the
  // heading and the floating one only appears once that one has scrolled out of sight (and never where IntersectionObserver is missing).
  const headAddRef = useRef<HTMLButtonElement>(null);
  const [headAddVisible, setHeadAddVisible] = useState(true);

  const ready = trainer.status === 'ready' || trainer.status === 'memory-only';
  const groups = useMemo(() => groupClips(trainer.clips, trainer.singers), [trainer.clips, trainer.singers]);
  const entries = useMemo(() => resolveQueue(trainer.queue, trainer.clips), [trainer.queue, trainer.clips]);
  const activeFilter = filter !== null && groups.some((g) => g.key === filter) ? filter : null;
  const shown = activeFilter ? groups.filter((g) => g.key === activeFilter) : groups;

  const hasClips = trainer.clips.length > 0;
  useEffect(() => {
    const el = headAddRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setHeadAddVisible(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ready, hasClips]);

  const openAdd = useCallback(() => goTrainer({ view: 'add' }), []);
  const closeAdd = useCallback(() => {
    clearPendingImport();
    goTrainer({ view: 'library' });
  }, []);

  // Opening the library again can succeed (and the notice then goes away with the button that was pressed): keep the focus in the page.
  const [retrying, setRetrying] = useState(false);
  const tryOpenAgain = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await extras.reload();
    } finally {
      setRetrying(false);
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) headingRef.current?.focus({ preventScroll: true });
      });
    }
  };

  const backup = async () => {
    setBackupNote(null);
    setBackupNote(await downloadLibraryBackup(trainer));
  };

  const onDragEnter = (e: DragEvent) => {
    if (!ready || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setOver(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!ready || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setOver(false);
  };
  const onDrop = (e: DragEvent) => {
    dragDepth.current = 0;
    setOver(false);
    if (!ready) return;
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => looksLikeMedia(f));
    if (files.length === 0) return;
    e.preventDefault();
    setPendingImport(files);
    openAdd();
  };

  // Clips that came back from a backup (or lost their audio) are listed, but cannot be practised until their file is added again.
  const needAudio = trainer.clips.filter((c) => c.audioMissing);

  const storage = trainer.storage;
  const storageLine =
    storage.usage !== null
      ? `${formatBytes(storage.usage)} on this device${storage.quota ? ` of about ${formatBytes(storage.quota)}` : ''}.`
      : null;

  return (
    <div
      className={`page page--trainer${over ? ' tr--over' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="page-head">
        <p className="eyebrow">Trainer</p>
        <h1 className="page-title" ref={headingRef} tabIndex={-1}>
          Practise with the voices you love
        </h1>
        <p className="lede">Copy a singer phrase by phrase: listen, sing along, and see exactly what to fix. Everything stays on this device.</p>
        {ready && trainer.clips.length > 0 && (
          <button ref={headAddRef} type="button" className="button button--accent tr-add-head" onClick={openAdd}>
            <Icon name="add" size={18} /> Add clips
          </button>
        )}
      </header>

      {trainer.status === 'loading' && (
        <p className="tr-loading" role="status">
          Opening your library…
        </p>
      )}

      {trainer.status === 'error' && (
        <Notice tone="error" title="Your library could not be opened">
          <p>{trainer.error ?? 'The place where clips are kept did not answer.'}</p>
          <p>Reload the app and try again. You can still record a free take in the Studio.</p>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={() => void extras.reload()}>
              Try again
            </button>
            <button type="button" className="button button--ghost button--small" onClick={() => window.location.reload()}>
              Reload the app
            </button>
            <a className="button button--ghost button--small" href="#studio">
              Go to the Studio
            </a>
          </div>
        </Notice>
      )}

      {trainer.status === 'memory-only' && (
        <Notice tone="warn" title={extras.canRetryOpen ? 'Your library did not open' : 'Clips will be lost when you close the app'}>
          <p>{extras.memoryReason ?? 'This browser would not give Mimic a place to keep clips.'}</p>
          {extras.canRetryOpen ? (
            <p>Clips you add now are kept only until you close the app, unless the library opens again: then they are copied into it. Mimic tries again when you come back to the app.</p>
          ) : (
            <p>
              {isDesktopKind(platformKind())
                ? desktopMemoryOnlyAdvice()
                : 'Add Mimic to your Home Screen to keep them, or save a backup after adding clips. A backup holds your phrases and scores; the audio itself would need to be added again.'}
            </p>
          )}
          {(extras.canRetryOpen || trainer.clips.length > 0) && (
            <div className="button-row">
              {extras.canRetryOpen && (
                <button type="button" className="button button--small" aria-disabled={retrying || undefined} aria-busy={retrying || undefined} onClick={() => void tryOpenAgain()}>
                  {retrying ? 'Trying again…' : 'Try again'}
                </button>
              )}
              {trainer.clips.length > 0 && (
                <button type="button" className="button button--small" onClick={() => void backup()}>
                  Back up my library
                </button>
              )}
            </div>
          )}
        </Notice>
      )}

      {extras.warnings.map((w) => (
        <Notice key={w} tone="warn">
          <p>{w}</p>
        </Notice>
      ))}

      {extras.exportReminder.due && extras.exportReminder.message && trainer.status !== 'memory-only' && (
        <Notice tone="info" title="A backup is worth making">
          <p>{extras.exportReminder.message}</p>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={() => void backup()}>
              Back up my library
            </button>
          </div>
        </Notice>
      )}
      {backupNote && (
        <Notice tone={backupNote.ok ? 'info' : 'error'} onDismiss={() => setBackupNote(null)}>
          <p>{backupNote.message}</p>
        </Notice>
      )}

      {ready && needAudio.length > 0 && (
        <Notice tone="warn" title={needAudio.length === 1 ? 'One clip needs its audio file again' : `${needAudio.length} clips need their audio files again`}>
          <p>
            A backup keeps your phrases and scores but never audio, so {needAudio.length === 1 ? 'this clip' : 'these clips'} cannot be practised until{' '}
            {needAudio.length === 1 ? 'its file is' : 'their files are'} added again. Choose the original {needAudio.length === 1 ? 'file' : 'files'} with Add clips: Mimic recognises each one by its
            contents and offers to re-attach it, so your phrases and scores stay exactly as they were.
          </p>
          <ul className="plain-list" aria-label="Clips that need their file">
            {needAudio.slice(0, 5).map((c) => (
              <li key={c.id}>
                <strong>{c.title}</strong>
                {c.sourceFileName && c.sourceFileName !== c.title ? <span className="muted"> ({c.sourceFileName})</span> : null}
              </li>
            ))}
            {needAudio.length > 5 && <li>and {needAudio.length - 5} more</li>}
          </ul>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={openAdd}>
              Choose the files
            </button>
          </div>
        </Notice>
      )}

      {/* On an iPhone, clips added in a Safari tab are not carried over to the installed app (it has its own storage): say so before
          the first import, and keep the steps near the library until the app is installed or the card is hidden. */}
      {ready && <InstallCard />}

      {ready && trainer.clips.length === 0 && <TrainerEmpty onAdd={openAdd} />}

      {ready && trainer.clips.length > 0 && (
        <>
          {entries.length > 0 ? (
            <Today entries={entries} />
          ) : (
            <p className="tr-nothing">
              {needAudio.length === trainer.clips.length
                ? 'Nothing can be practised until the audio files are added again.'
                : 'Nothing is due today. Open any clip below and pick a phrase, or add another clip.'}
            </p>
          )}

          {groups.length > 1 && (
            <div className="tr-filter" role="group" aria-label="Show clips of">
              <button type="button" className="tr-chip" aria-pressed={activeFilter === null} onClick={() => setFilter(null)}>
                All
              </button>
              {groups.map((g) => (
                <button key={g.key} type="button" className="tr-chip" aria-pressed={activeFilter === g.key} onClick={() => setFilter(g.key)}>
                  {g.name}
                  <span className="tr-chip-count num"> {g.clips.length}</span>
                </button>
              ))}
            </div>
          )}

          {shown.map((g) => (
            <section key={g.key} className="tr-group" aria-labelledby={`tr-g-${g.key}`}>
              <h2 id={`tr-g-${g.key}`} className="tr-group-name">
                <span className="tr-group-dot" style={{ background: clipColor(g.singer) }} aria-hidden="true" />
                {g.name}
              </h2>
              <ul className="tr-clips">
                {g.clips.map((c) => (
                  <li key={c.id}>
                    <ClipCard clip={c} singer={g.singer} now={props.now} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      {ready && trainer.clips.length > 0 && !headAddVisible && (
        <div className="tr-dock">
          <button type="button" className="add-button" onClick={openAdd}>
            <Icon name="add" size={22} /> Add clips
          </button>
        </div>
      )}

      {(storageLine || extras.storageNote) && (
        <p className="tr-storage">
          {storageLine} {extras.storageNote}
        </p>
      )}

      {props.adding && <ImportSheet onClose={closeAdd} initialFiles={peekPendingImport()} />}
    </div>
  );
}

export function TrainerPage(props: { now?: number }) {
  const path = useTrainerPath();
  const now = props.now ?? Date.now();
  // The first screen of a visit keeps the focus the shell gave it; moving between screens inside the Trainer moves focus to the new heading.
  const shown = useRef(false);
  const focusHeading = shown.current;
  useEffect(() => {
    shown.current = true;
  }, []);
  if (path.view === 'clip') return <ClipView key={path.clipId} clipId={path.clipId} now={now} focusHeading={focusHeading} />;
  if (path.view === 'phrase') {
    return <PracticeView key={`${path.clipId}/${path.phraseNumber}`} clipId={path.clipId} phraseNumber={path.phraseNumber} now={now} focusHeading={focusHeading} />;
  }
  return <LibraryView now={now} adding={path.view === 'add'} focusHeading={focusHeading} />;
}
