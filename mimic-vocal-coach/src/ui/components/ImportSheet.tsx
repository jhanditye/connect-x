// The Add clips sheet: pick one or more files (Files app, Voice Memos saved to Files, phone videos, drag and drop), read them one
// at a time with progress, review each (ClipReview), save, and finish with a summary. It is also the way to give a clip its
// audio back after a library import (relink mode). A full-screen dialog: focus stays inside, Escape closes (asking first when
// there is unsaved work), and the app behind it is inert. The library and its store are reached through useTrainer().

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { looksLikeMedia, MEDIA_ACCEPT } from '../../audio/decode';
import { useTrainer } from '../../state/trainerContext';
import { QuotaError, StoreUnavailableError } from '../../storage/clips';
import { findRelinkMatches, reanalyzeClip, sameSource, type CommitEdits, type ImportProgress, type PreparedClip } from '../../trainer/import';
import { IMPORT_FORMATS, IMPORT_LEDE, IMPORT_STEPS, PRIVACY_NOTE, PROTECTED_HELP, STEM_HELP, VIDEO_HELP } from '../../trainer/importCopy';
import type { ClipKind, ClipRecord } from '../../types';
import { ClipReview } from './ClipReview';
import { Icon } from './Icon';
import { Notice } from './Notice';
import type { SamplePlayer } from './samplePlayer';
import './clipImport.css';

// ---------------------------------------------------------------------------------------------
// The queue of files

type ItemStatus = 'queued' | 'preparing' | 'ready' | 'saving' | 'saved' | 'skipped' | 'failed';

interface Item {
  id: number;
  file: File;
  status: ItemStatus;
  progress: ImportProgress | null;
  prepared: PreparedClip | null;
  error: string | null;
  saveError: string | null;
  clip: ClipRecord | null;
  /** Set when the audio of an existing clip was re-attached instead of adding a new one. */
  relinked: boolean;
}

interface State {
  step: 'pick' | 'work' | 'done';
  items: Item[];
  /** Index of the file being worked on. */
  current: number;
}

type Action =
  | { type: 'add'; files: File[] }
  | { type: 'preparing'; id: number }
  | { type: 'progress'; id: number; progress: ImportProgress }
  | { type: 'prepared'; id: number; prepared: PreparedClip }
  | { type: 'failed'; id: number; error: string }
  | { type: 'saving'; id: number }
  | { type: 'saved'; id: number; clip: ClipRecord; relinked?: boolean }
  | { type: 'saveFailed'; id: number; error: string }
  | { type: 'skip'; id: number }
  | { type: 'next' }
  | { type: 'reset' };

let nextItemId = 1;

function patch(state: State, id: number, change: Partial<Item>): State {
  return { ...state, items: state.items.map((it) => (it.id === id ? { ...it, ...change } : it)) };
}

/** After a file is finished, the next one that still needs work; none left means the summary. */
function advance(state: State): State {
  const next = state.items.findIndex((it, i) => i > state.current && it.status !== 'saved' && it.status !== 'skipped');
  if (next >= 0) return { ...state, current: next };
  const earlier = state.items.findIndex((it) => it.status === 'queued' || it.status === 'preparing' || it.status === 'ready' || it.status === 'saving');
  return earlier >= 0 ? { ...state, current: earlier } : { ...state, step: 'done' };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'add': {
      const fresh: Item[] = action.files.map((file) => ({ id: nextItemId++, file, status: 'queued', progress: null, prepared: null, error: null, saveError: null, clip: null, relinked: false }));
      const keep = state.step === 'work' ? state.items : [];
      return { step: 'work', items: [...keep, ...fresh], current: state.step === 'work' ? state.current : 0 };
    }
    case 'preparing':
      return patch(state, action.id, { status: 'preparing' });
    case 'progress':
      return patch(state, action.id, { progress: action.progress });
    case 'prepared': {
      const it = state.items.find((i) => i.id === action.id);
      if (!it || it.status === 'skipped') return state; // skipped while it was being read: drop the result
      return patch(state, action.id, { status: 'ready', prepared: action.prepared, progress: null });
    }
    case 'failed': {
      const it = state.items.find((i) => i.id === action.id);
      if (!it || it.status === 'skipped') return state;
      return patch(state, action.id, { status: 'failed', error: action.error, progress: null });
    }
    case 'saving':
      return patch(state, action.id, { status: 'saving', saveError: null });
    case 'saved':
      return advance(patch(state, action.id, { status: 'saved', clip: action.clip, prepared: null, relinked: !!action.relinked }));
    case 'saveFailed':
      return patch(state, action.id, { status: 'ready', saveError: action.error });
    case 'skip':
      return advance(patch(state, action.id, { status: 'skipped', prepared: null, progress: null }));
    case 'next':
      return advance(state);
    case 'reset':
      return { step: 'pick', items: [], current: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const OWNED_KEY = 'mimic:v1:trainer-owned';

function readOwned(): boolean {
  try {
    return localStorage.getItem(OWNED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOwned(on: boolean): void {
  try {
    if (on) localStorage.setItem(OWNED_KEY, '1');
    else localStorage.removeItem(OWNED_KEY);
  } catch {
    // Not remembered: the box starts empty next time.
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** What went wrong while storing, with the next step. */
export function saveErrorMessage(err: unknown): string {
  if (err instanceof QuotaError) return `${err.message} Remove clips you no longer practise in the Trainer, or keep a shorter part of this one, then save again.`;
  if (err instanceof StoreUnavailableError) return `${err.message} Reload the app and try again. If it keeps happening, export a backup from Settings first.`;
  return messageOf(err, 'The clip could not be saved. Try again, or keep a shorter part of the file.');
}

const PHASE_WORDS: Record<ImportProgress['phase'], string> = {
  reading: 'Opening the file',
  decoding: 'Reading the sound',
  analysing: 'Listening for the melody',
  segmenting: 'Finding the phrases',
  storing: 'Saving',
};
const PHASE_SPAN: Record<ImportProgress['phase'], [number, number]> = {
  reading: [0, 0.02],
  decoding: [0.02, 0.3],
  analysing: [0.3, 0.92],
  segmenting: [0.92, 1],
  storing: [0, 1],
};

/** One 0..1 number for the whole preparation of a file. */
export function overallProgress(p: ImportProgress | null): number {
  if (!p) return 0;
  const [from, to] = PHASE_SPAN[p.phase];
  return from + (to - from) * Math.max(0, Math.min(1, p.fraction));
}

/** Not hidden and not inside a closed <details> (whose summary stays reachable). */
function isTabbable(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false;
  const closed = el.closest('details:not([open])');
  return !closed || (el.tagName === 'SUMMARY' && el.parentElement === closed);
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

// ---------------------------------------------------------------------------------------------
// The sheet

export interface ImportSheetProps {
  onClose(): void;
  /** Called after each clip is stored. */
  onSaved?(clip: ClipRecord): void;
  /** Files that were already chosen, for example dropped on the library. */
  initialFiles?: File[];
  /** Give this clip its audio back (after a library import) instead of adding new clips. */
  relinkClipId?: string;
  /** Test seams. */
  reanalyze?: (prepared: PreparedClip, kind: ClipKind, onProgress?: (p: ImportProgress) => void) => Promise<PreparedClip>;
  createPlayer?: () => SamplePlayer;
}

export function ImportSheet(props: ImportSheetProps) {
  const trainer = useTrainer();
  const trainerRef = useRef(trainer);
  trainerRef.current = trainer;
  const titleId = useId();
  const [state, dispatch] = useReducer(reducer, { step: 'pick', items: [], current: 0 } satisfies State);
  const [rejected, setRejected] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [over, setOver] = useState(false);
  const [announce, setAnnounce] = useState('');
  const started = useRef(new Set<number>());
  const alive = useRef(true);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'imp-host';
    return el;
  });

  const relinkClip = props.relinkClipId ? trainer.getClip(props.relinkClipId) : undefined;
  const relinkMode = props.relinkClipId !== undefined;
  const ready = trainer.status === 'ready' || trainer.status === 'memory-only';

  // ----- dialog behaviour: host node, inert background, focus, scroll lock

  useLayoutEffect(() => {
    document.body.appendChild(host);
    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.tagName === 'SCRIPT') continue;
      if (!el.hasAttribute('inert')) {
        el.setAttribute('inert', '');
        el.setAttribute('aria-hidden', 'true');
        inerted.push(el);
      }
    }
    document.documentElement.classList.add('imp-open');
    return () => {
      for (const el of inerted) {
        el.removeAttribute('inert');
        el.removeAttribute('aria-hidden');
      }
      document.documentElement.classList.remove('imp-open');
      host.remove();
    };
  }, [host]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();
    return () => {
      if (before && document.contains(before) && typeof before.focus === 'function') before.focus();
    };
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ----- adding files

  const addFiles = useCallback(
    (files: File[]) => {
      const media = files.filter((f) => looksLikeMedia(f));
      const others = files.filter((f) => !looksLikeMedia(f));
      setRejected(
        others.length
          ? `${others.map((f) => `"${f.name}"`).join(', ')} ${others.length === 1 ? 'does' : 'do'} not look like audio or video. Pick ${IMPORT_FORMATS}`
          : null,
      );
      const take = relinkMode ? media.slice(0, 1) : media;
      if (take.length > 0) {
        setConfirmClose(false);
        dispatch({ type: 'add', files: take });
      }
    },
    [relinkMode],
  );

  const initialDone = useRef(false);
  useEffect(() => {
    if (initialDone.current || !props.initialFiles?.length) return;
    initialDone.current = true;
    addFiles(props.initialFiles);
  }, [props.initialFiles, addFiles]);

  // ----- reading files: the one being reviewed and the next, so the wait is mostly hidden

  useEffect(() => {
    if (state.step !== 'work') return;
    const wanted = relinkMode ? [state.current] : [state.current, state.current + 1];
    for (const index of wanted) {
      const item = state.items[index];
      if (!item || item.status !== 'queued' || started.current.has(item.id)) continue;
      started.current.add(item.id);
      dispatch({ type: 'preparing', id: item.id });
      trainerRef.current
        .prepareClip(item.file, (p) => alive.current && dispatch({ type: 'progress', id: item.id, progress: p }))
        .then((prepared) => alive.current && dispatch({ type: 'prepared', id: item.id, prepared }))
        .catch((err: unknown) => alive.current && dispatch({ type: 'failed', id: item.id, error: messageOf(err, `Could not read ${item.file.name}. Try another file.`) }));
    }
  }, [state.step, state.items, state.current, relinkMode]);

  const current = state.items[state.current];

  // Relink mode: once the file is read, check it is the right one and attach it.
  useEffect(() => {
    if (!relinkMode || !current || current.status !== 'ready' || !current.prepared || !relinkClip) return;
    const prepared = current.prepared;
    const id = current.id;
    if (findRelinkMatches([{ ...relinkClip, audioMissing: true }], prepared).length === 0) {
      dispatch({
        type: 'failed',
        id,
        error: `This does not look like the file for "${relinkClip.title}" (${relinkClip.sourceFileName}). Pick the file you originally added, or add this one as a new clip.`,
      });
      return;
    }
    dispatch({ type: 'saving', id });
    trainerRef.current
      .relinkClip(relinkClip.id, prepared)
      .then((clip) => {
        if (!alive.current) return;
        dispatch({ type: 'saved', id, clip, relinked: true });
        props.onSaved?.(clip);
        setAnnounce(`Audio re-attached to ${clip.title}.`);
      })
      .catch((err: unknown) => alive.current && dispatch({ type: 'failed', id, error: messageOf(err, 'The audio could not be attached. Try the file again.') }));
    // props.onSaved is intentionally not a dependency: the attempt runs once per ready file.
  }, [relinkMode, current, relinkClip]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!current) return;
    if (current.status === 'ready') setAnnounce(`${current.file.name} is ready to review.`);
    else if (current.status === 'failed') setAnnounce(`Could not read ${current.file.name}.`);
  }, [current?.id, current?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- saving

  const save = async (item: Item, edits: CommitEdits, prepared: PreparedClip) => {
    dispatch({ type: 'saving', id: item.id });
    try {
      const clip = await trainerRef.current.commitClip(prepared, edits);
      if (!alive.current) return;
      dispatch({ type: 'saved', id: item.id, clip });
      props.onSaved?.(clip);
      setAnnounce(`Saved ${clip.title}.`);
    } catch (err) {
      if (alive.current) dispatch({ type: 'saveFailed', id: item.id, error: saveErrorMessage(err) });
    }
  };

  const reattach = async (item: Item, existing: ClipRecord) => {
    if (!item.prepared) return;
    dispatch({ type: 'saving', id: item.id });
    try {
      const clip = await trainerRef.current.relinkClip(existing.id, item.prepared);
      if (!alive.current) return;
      dispatch({ type: 'saved', id: item.id, clip, relinked: true });
      props.onSaved?.(clip);
    } catch (err) {
      if (alive.current) dispatch({ type: 'saveFailed', id: item.id, error: messageOf(err, 'The audio could not be attached. Add the file as a new clip instead.') });
    }
  };

  // ----- closing

  const unsavedCount = state.items.filter((it) => it.status === 'queued' || it.status === 'preparing' || it.status === 'ready' || it.status === 'saving').length;
  const unsaved = unsavedCount > 0;
  const requestClose = () => {
    if (unsaved && state.step === 'work') setConfirmClose(true);
    else props.onClose();
  };

  // Escape closes the sheet wherever the focus is (it can fall to the page when the control that had it goes away).
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) requestCloseRef.current();
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, []);

  // When the control that had the focus goes away (a step finished), keep the focus in the sheet.
  useEffect(() => {
    const root = sheetRef.current;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const root = sheetRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabbable);
    if (nodes.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // ----- render

  const heading = state.step === 'pick' ? (relinkMode ? 'Add the file again' : 'Add clips') : state.step === 'done' ? (relinkMode ? 'Done' : 'Finished') : relinkMode ? 'Add the file again' : 'Add clips';
  const savedCount = state.items.filter((it) => it.status === 'saved').length;

  return createPortal(
    <div className="imp-overlay">
      <div className="imp-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={sheetRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="imp-top">
          <h2 className="imp-heading" id={titleId}>
            {heading}
          </h2>
          <button type="button" className="icon-button icon-button--touch" onClick={requestClose} aria-label="Close">
            <Icon name="close" size={22} />
          </button>
        </div>

        <div className="imp-body">
          {confirmClose && (
            <div className="confirm" role="group" aria-label="Confirm closing">
              <p>
                {unsavedCount === 1 ? '1 file has' : `${unsavedCount} files have`} not been saved yet. Close and leave {unsavedCount === 1 ? 'it' : 'them'} out?
              </p>
              <div className="button-row">
                <button type="button" className="button button--ghost" onClick={() => setConfirmClose(false)}>
                  Keep going
                </button>
                <button type="button" className="button button--danger" onClick={props.onClose}>
                  Close without saving
                </button>
              </div>
            </div>
          )}

          {trainer.status === 'loading' && <Notice tone="info">Opening your library. This takes a moment.</Notice>}
          {trainer.status === 'error' && (
            <Notice tone="error" title="The library is not available">
              {trainer.error ?? 'Clips cannot be stored right now.'} Reload the app, and if it keeps happening export a backup from Settings.
            </Notice>
          )}
          {trainer.status === 'memory-only' && (
            <Notice tone="warn" title="Clips will be lost when you close the app">
              This browser would not give Mimic a place to keep them. Add the app to your Home Screen, or export a backup after adding clips.
            </Notice>
          )}

          {relinkMode && !relinkClip && state.step !== 'done' && (
            <div>
              <Notice tone="error" title="That clip is no longer in the library">
                There is nothing to attach the file to. Close this and add the file as a new clip instead.
              </Notice>
              <div className="button-row">
                <button type="button" className="button button--accent" onClick={props.onClose}>
                  Close
                </button>
              </div>
            </div>
          )}

          {state.step === 'pick' && (relinkClip || !relinkMode) && (
            <PickStep
              relinkTitle={relinkMode ? (relinkClip?.title ?? 'this clip') : null}
              relinkFile={relinkClip?.sourceFileName ?? null}
              disabled={!ready}
              over={over}
              setOver={setOver}
              rejected={rejected}
              onFiles={addFiles}
            />
          )}

          {state.step === 'work' && current && (relinkClip || !relinkMode) && (
            <WorkStep
              state={state}
              item={current}
              relinkMode={relinkMode}
              relinkTitle={relinkClip?.title}
              trainer={trainer}
              sheet={props}
              onSave={save}
              onReattach={reattach}
              onSkip={(id) => dispatch({ type: 'skip', id })}
              onNext={() => dispatch({ type: 'next' })}
              onPickOthers={() => dispatch({ type: 'reset' })}
            />
          )}

          {state.step === 'done' && (
            <DoneStep
              items={state.items}
              savedCount={savedCount}
              relinkMode={relinkMode}
              onMore={() => {
                started.current.clear();
                dispatch({ type: 'reset' });
              }}
              onClose={props.onClose}
            />
          )}
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </p>
      </div>
    </div>,
    host,
  );
}

// ---------------------------------------------------------------------------------------------
// Steps

function PickStep(props: {
  relinkTitle: string | null;
  relinkFile: string | null;
  disabled: boolean;
  over: boolean;
  setOver(on: boolean): void;
  rejected: string | null;
  onFiles(files: File[]): void;
}) {
  const inputId = useId();
  const relink = props.relinkTitle !== null;
  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) props.onFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    props.setOver(false);
    if (!props.disabled) take(e.dataTransfer?.files);
  };
  return (
    <div>
      {relink ? (
        <p className="lede">
          Pick the file you originally added for <strong>{props.relinkTitle}</strong>
          {props.relinkFile ? ` (${props.relinkFile})` : ''}. Mimic matches it by its contents, so your phrases and scores stay as they are.
        </p>
      ) : (
        <p className="lede">{IMPORT_LEDE}</p>
      )}

      <div
        className={`filedrop imp-drop${props.over ? ' filedrop--over' : ''}${props.disabled ? ' filedrop--disabled' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!props.disabled) props.setOver(true);
        }}
        onDragLeave={() => props.setOver(false)}
        onDrop={onDrop}
      >
        <input
          id={inputId}
          className="visually-hidden"
          type="file"
          accept={MEDIA_ACCEPT}
          multiple={!relink}
          disabled={props.disabled}
          onChange={(e) => {
            take(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <label htmlFor={inputId} className="filedrop-label">
          <Icon name="upload" size={20} />
          <span className="filedrop-text">
            <span className="filedrop-title">{relink ? 'Choose the file' : 'Choose files'}</span>
            <span className="filedrop-hint">{props.disabled ? 'Waiting for the library to open.' : `${IMPORT_FORMATS} You can drop files here too.`}</span>
          </span>
        </label>
      </div>
      {props.rejected && (
        <p className="field-error" role="alert">
          {props.rejected}
        </p>
      )}

      {!relink && (
        <>
          <ol className="imp-steps">
            {IMPORT_STEPS.map((s) => (
              <li key={s.title}>
                <strong>{s.title}.</strong> {s.body}
              </li>
            ))}
          </ol>
          <details className="imp-more">
            <summary>Videos from your phone</summary>
            <p>{VIDEO_HELP}</p>
          </details>
          <details className="imp-more">
            <summary>Protected songs and Apple Music</summary>
            <p>{PROTECTED_HELP}</p>
          </details>
          <details className="imp-more">
            <summary>No isolated vocal?</summary>
            <p>{STEM_HELP}</p>
          </details>
        </>
      )}
      <p className="caveat">{PRIVACY_NOTE}</p>
    </div>
  );
}

function WorkStep(props: {
  state: State;
  item: Item;
  relinkMode: boolean;
  relinkTitle: string | undefined;
  trainer: ReturnType<typeof useTrainer>;
  sheet: ImportSheetProps;
  onSave(item: Item, edits: CommitEdits, prepared: PreparedClip): void;
  onReattach(item: Item, existing: ClipRecord): void;
  onSkip(id: number): void;
  onNext(): void;
  onPickOthers(): void;
}) {
  const { item, state, trainer } = props;
  const count = state.items.length;
  const duplicate = item.prepared ? trainer.clips.find((c) => sameSource(c.fingerprint, item.prepared?.fingerprint ?? '')) : undefined;

  return (
    <div>
      {count > 1 && <Queue items={state.items} current={state.current} />}

      {(item.status === 'queued' || item.status === 'preparing') && <PreparingCard item={item} onSkip={props.relinkMode ? undefined : () => props.onSkip(item.id)} />}

      {item.status === 'failed' && (
        <div>
          <Notice tone="error" title={`Could not use ${item.file.name}`}>
            {item.error}
          </Notice>
          <div className="button-row">
            {!props.relinkMode && count > 1 && state.items.some((it, i) => i > state.current && it.status !== 'saved' && it.status !== 'skipped') && (
              <button type="button" className="button button--accent" onClick={props.onNext}>
                Continue with the next file
              </button>
            )}
            <button type="button" className="button" onClick={props.onPickOthers}>
              Choose different files
            </button>
            {!props.relinkMode && count > 1 && (
              <button type="button" className="button button--ghost" onClick={() => props.onSkip(item.id)}>
                Leave this one out
              </button>
            )}
          </div>
        </div>
      )}

      {(item.status === 'ready' || item.status === 'saving') && item.prepared && !props.relinkMode && (
        <ClipReview
          key={item.id}
          prepared={item.prepared}
          singers={trainer.singers}
          position={{ index: state.items.slice(0, state.current).filter((it) => it.status !== 'skipped').length, count: state.items.filter((it) => it.status !== 'skipped').length }}
          storage={trainer.storage}
          ownedDefault={readOwned()}
          onOwnedChange={writeOwned}
          saving={item.status === 'saving'}
          saveError={item.saveError}
          onSave={(edits, prepared) => props.onSave(item, edits, prepared)}
          onSkip={count > 1 ? () => props.onSkip(item.id) : undefined}
          reanalyze={props.sheet.reanalyze ?? reanalyzeClip}
          prepareStem={(file, onProgress) => trainer.prepareClip(file, onProgress)}
          createPlayer={props.sheet.createPlayer}
          banner={
            duplicate ? (
              duplicate.audioMissing ? (
                <Notice tone="info" title={`This is the file for "${duplicate.title}"`}>
                  <p>That clip is in your library but its audio is not on this device. Re-attach the audio to keep its phrases and scores, or save this as a new clip below.</p>
                  <div className="button-row">
                    <button type="button" className="button button--accent" disabled={item.status === 'saving'} onClick={() => props.onReattach(item, duplicate)}>
                      Re-attach the audio
                    </button>
                  </div>
                </Notice>
              ) : (
                <Notice tone="warn" title={`Already in your library as "${duplicate.title}"`}>
                  Saving it again makes a second copy with its own scores. Skip it, or carry on if that is what you want.
                </Notice>
              )
            ) : undefined
          }
        />
      )}

      {item.status === 'saving' && props.relinkMode && (
        <p role="status" className="muted">
          Attaching the audio to {props.relinkTitle ?? 'the clip'}.
        </p>
      )}
    </div>
  );
}

function PreparingCard(props: { item: Item; onSkip?: () => void }) {
  const p = props.item.progress;
  const pct = Math.round(overallProgress(p) * 100);
  const phase = p ? PHASE_WORDS[p.phase] : 'Opening the file';
  const label = `${phase}: ${props.item.file.name}`;
  return (
    <div className="imp-preparing" role="status">
      <p className="imp-preparing-name">
        <Icon name="file" size={18} /> <span>{props.item.file.name}</span>
      </p>
      <div className="analysis-progress-row">
        <span>{phase}</span>
        <span className="num">{pct}%</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="field-hint">A long song takes a little longer. You can leave this open.</p>
      {props.onSkip && (
        <button type="button" className="button button--ghost" onClick={props.onSkip}>
          Skip this file
        </button>
      )}
    </div>
  );
}

function Queue(props: { items: Item[]; current: number }) {
  const words: Record<ItemStatus, string> = {
    queued: 'waiting',
    preparing: 'reading',
    ready: 'ready',
    saving: 'saving',
    saved: 'saved',
    skipped: 'left out',
    failed: 'problem',
  };
  return (
    <ol className="imp-queue" aria-label="Files to add">
      {props.items.map((it, i) => (
        <li key={it.id} className={`imp-queue-item imp-queue-item--${it.status}${i === props.current ? ' imp-queue-item--current' : ''}`} aria-current={i === props.current ? 'step' : undefined}>
          <span className="imp-queue-name">{it.file.name}</span>
          <span className="chip">{words[it.status]}</span>
        </li>
      ))}
    </ol>
  );
}

function DoneStep(props: { items: Item[]; savedCount: number; relinkMode: boolean; onMore(): void; onClose(): void }) {
  const headingRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const failed = props.items.filter((it) => it.status === 'failed');
  const skipped = props.items.filter((it) => it.status === 'skipped');
  return (
    <div>
      <p className="lede" tabIndex={-1} ref={headingRef}>
        {props.savedCount > 0
          ? props.relinkMode
            ? 'The audio is back. Your phrases and scores are as you left them.'
            : `Added ${props.savedCount} clip${props.savedCount === 1 ? '' : 's'}. They are in your library, ready to practise.`
          : 'Nothing was added.'}
      </p>
      <ul className="imp-results">
        {props.items.map((it) => (
          <li key={it.id}>
            <span className="imp-result-name">{it.clip ? it.clip.title : it.file.name}</span>
            <span className={`chip${it.status === 'saved' ? ' chip--good' : ''}`}>{it.status === 'saved' ? (it.relinked ? 'audio re-attached' : `saved, ${it.clip?.phrases.filter((p) => !p.hidden).length ?? 0} phrases`) : it.status === 'failed' ? 'problem' : 'left out'}</span>
            {it.status === 'failed' && it.error && <span className="imp-result-why">{it.error}</span>}
          </li>
        ))}
      </ul>
      {failed.length + skipped.length > 0 && props.savedCount === 0 && <p className="field-hint">Choose different files to try again.</p>}
      <div className="button-row">
        {!props.relinkMode && (
          <button type="button" className="button" onClick={props.onMore}>
            <Icon name="add" size={18} />
            <span>Add more clips</span>
          </button>
        )}
        {props.relinkMode && failed.length > 0 && (
          <button type="button" className="button" onClick={props.onMore}>
            Choose a different file
          </button>
        )}
        <button type="button" className="button button--accent" onClick={props.onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
