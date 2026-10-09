// The Add clips sheet: pick one or more files (Files app, Voice Memos saved to Files, phone videos, drag and drop), read them one
// at a time with progress, review each (ClipReview), save, and finish with a summary. It is also the way to give a clip its
// audio back after a library import (relink mode). A full-screen dialog: focus stays inside, Escape closes (asking first when
// there is unsaved work), and the app behind it is inert. The library and its store are reached through useTrainer().

import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { looksLikeMedia, MEDIA_ACCEPT } from '../../audio/decode';
import { checkSeparation, type SeparationAvailability } from '../../audio/separation/client';
import { useTrainer } from '../../state/trainerContext';
import { QuotaError, StoreUnavailableError } from '../../storage/clips';
import { isAbortError } from '../../analysis/abort';
import { findRelinkMatches, isolatePrepared, reanalyzeClip, relinkIsolateRequest, sameSource, type CommitEdits, type ImportProgress, type IsolateRequest, type PreparedClip } from '../../trainer/import';
import { importWords, PRIVACY_NOTE } from '../../trainer/importCopy';
import { setSheetDropTarget } from '../windowFileDrop';
import { desktopMemoryOnlyAdvice, deviceNoun } from '../../pwa/words';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import type { ClipKind, ClipRecord } from '../../types';
import { ClipReview } from './ClipReview';
import { BrowserTabNote } from './InstallCard';
import { Icon } from './Icon';
import { DEFAULT_ISOLATE_CHOICE, etaWords, IsolateChoiceCard, parseClock, progressWords, requestFromChoice, type IsolateChoice } from './IsolateOptions';
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
  /** Pull the vocal out of the song first (chosen when the file was added), or null for a normal import. */
  isolate: IsolateRequest | null;
}

interface State {
  step: 'pick' | 'work' | 'done';
  items: Item[];
  /** Index of the file being worked on. */
  current: number;
}

type Action =
  | { type: 'add'; files: File[]; isolate?: IsolateRequest | null }
  | { type: 'retry'; id: number; isolate: IsolateRequest | null }
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
      const fresh: Item[] = action.files.map((file) => ({ id: nextItemId++, file, status: 'queued', progress: null, prepared: null, error: null, saveError: null, clip: null, relinked: false, isolate: action.isolate ?? null }));
      const keep = state.step === 'work' ? state.items : [];
      return { step: 'work', items: [...keep, ...fresh], current: state.step === 'work' ? state.current : 0 };
    }
    case 'preparing':
      return patch(state, action.id, { status: 'preparing' });
    case 'retry':
      return patch(state, action.id, { status: 'queued', error: null, progress: null, prepared: null, isolate: action.isolate });
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

/**
 * An earlier version remembered the "this file is mine" tick for the next file. It is a statement about each file, so it is asked every
 * time; the old remembered value is removed.
 */
const OLD_OWNED_KEY = 'mimic:v1:trainer-owned';

function forgetOldOwnedTick(): void {
  try {
    localStorage.removeItem(OLD_OWNED_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The page's own heading (or its main area), made focusable: where the focus goes when the control that opened the sheet is gone. */
function focusPage(): void {
  const el = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('main');
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
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
  'downloading-model': 'Downloading the vocal model (one time)',
  isolating: 'Splitting the song into voice and band',
  analysing: 'Listening for the melody',
  segmenting: 'Finding the phrases',
  storing: 'Saving',
};
const PHASE_SPAN: Record<ImportProgress['phase'], [number, number]> = {
  reading: [0, 0.02],
  decoding: [0.02, 0.3],
  'downloading-model': [0.3, 0.3],
  isolating: [0.3, 0.3],
  analysing: [0.3, 0.92],
  segmenting: [0.92, 1],
  storing: [0, 1],
};
/** A file that is split into its vocal first: the splitting is most of the wait, so it gets most of the bar. */
const ISOLATE_SPAN: Record<ImportProgress['phase'], [number, number]> = {
  reading: [0, 0.01],
  decoding: [0.01, 0.06],
  'downloading-model': [0.06, 0.14],
  isolating: [0.14, 0.85],
  analysing: [0.85, 0.97],
  segmenting: [0.97, 1],
  storing: [0, 1],
};

/** One 0..1 number for the whole preparation of a file. */
export function overallProgress(p: ImportProgress | null): number {
  if (!p) return 0;
  const [from, to] = (p.isolating ? ISOLATE_SPAN : PHASE_SPAN)[p.phase];
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
  /** Test seam for vocal isolation: whether it is offered, and the review's "Isolate the vocal" step. Defaults to the real thing. */
  separation?: {
    check(): Promise<SeparationAvailability>;
    isolate?(prepared: PreparedClip, onProgress: (p: ImportProgress) => void, signal: AbortSignal): Promise<PreparedClip>;
  };
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
  // Vocal isolation (optional, off by default): offered only when the app can really do it. Asked once when the sheet opens.
  const [sep, setSep] = useState<SeparationAvailability | null>(null);
  const [choice, setChoice] = useState<IsolateChoice>(DEFAULT_ISOLATE_CHOICE);
  const started = useRef(new Set<number>());
  /** One AbortController per file being read: skipping a file, closing the sheet or leaving stops its analysis worker. */
  const controllers = useRef(new Map<number, AbortController>());
  /** Cancels what is not tied to one file in the queue (reading a vocal-only file in the review). */
  const sheetAbort = useRef<AbortController | null>(null);
  const announcedAnalysing = useRef(new Set<number>());
  const announcedSteps = useRef(new Set<string>());
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
    forgetOldOwnedTick();
    return () => {
      // Back to the control that opened the sheet; when it is gone (the empty-state button disappears with the first clip), to the page.
      if (before && before !== document.body && document.contains(before) && typeof before.focus === 'function') before.focus();
      else focusPage();
    };
  }, []);

  const checkSep = props.separation?.check;
  useEffect(() => {
    const controller = new AbortController();
    void (checkSep ? checkSep() : checkSeparation({ signal: controller.signal }))
      .then((a) => !controller.signal.aborted && setSep(a))
      .catch(() => undefined); // not offered
    return () => controller.abort();
  }, [checkSep]);

  const abortAll = useCallback(() => {
    for (const c of controllers.current.values()) c.abort();
    controllers.current.clear();
    sheetAbort.current?.abort();
    sheetAbort.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abortAll(); // closing the sheet (or leaving the page) must not leave an analysis running for a result nobody will see
    };
  }, [abortAll]);

  /** Stops reading one file (it was skipped); other files go on. */
  const abortItem = (id: number) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
  };

  // ----- adding files

  const addFiles = useCallback(
    (files: File[]) => {
      const media = files.filter((f) => looksLikeMedia(f));
      const others = files.filter((f) => !looksLikeMedia(f));
      setRejected(
        others.length
          ? `${others.map((f) => `"${f.name}"`).join(', ')} ${others.length === 1 ? 'does' : 'do'} not look like audio or video. Pick ${importWords(platformKind()).formats}`
          : null,
      );
      const take = relinkMode ? media.slice(0, 1) : media;
      if (take.length > 0) {
        setConfirmClose(false);
        // Giving an isolated clip its audio back means isolating the same part of the song again.
        const isolate: IsolateRequest | null = relinkMode
          ? relinkClip
            ? relinkIsolateRequest(relinkClip)
            : null
          : sep?.available
            ? requestFromChoice(choice)
            : null;
        dispatch({ type: 'add', files: take, isolate });
      }
    },
    [relinkMode, relinkClip, sep, choice],
  );

  // Files dropped on the window outside the drop area (the margin beside the page) are taken wherever the drop area itself would take
  // them: on the first step, once the library is open, and not while the vocal start time needs fixing. Elsewhere they are ignored.
  const takesDrops = useRef(false);
  takesDrops.current =
    state.step === 'pick' && ready && (relinkClip || !relinkMode) && !(sep?.available && !relinkMode && choice.on && parseClock(choice.start) === null);
  useEffect(() => setSheetDropTarget((files) => (takesDrops.current ? addFiles(files) : undefined)), [addFiles]);

  const initialDone = useRef(false);
  useEffect(() => {
    if (initialDone.current || !props.initialFiles?.length) return;
    initialDone.current = true;
    addFiles(props.initialFiles);
  }, [props.initialFiles, addFiles]);

  // ----- reading files: the one being reviewed, then the next one while it is reviewed, so the wait is mostly hidden. Never more than
  // one file is read at a time apart from that look-ahead: every file read holds its samples and an analysis worker in memory.

  const currentIdRef = useRef<number | null>(null);
  currentIdRef.current = state.items[state.current]?.id ?? null;

  useEffect(() => {
    if (state.step !== 'work') return;
    const cur = state.items[state.current];
    const next = relinkMode ? undefined : state.items[state.current + 1];
    const start = (item: Item) => {
      started.current.add(item.id);
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      dispatch({ type: 'preparing', id: item.id });
      trainerRef.current
        .prepareClip(
          item.file,
          (p) => {
            if (!alive.current || controller.signal.aborted) return;
            dispatch({ type: 'progress', id: item.id, progress: p });
            // One announcement when the long part starts, not one per percent.
            if (p.phase === 'analysing' && item.id === currentIdRef.current && !announcedAnalysing.current.has(item.id)) {
              announcedAnalysing.current.add(item.id);
              setAnnounce(`Listening for the melody in ${item.file.name}.`);
            }
            if ((p.phase === 'downloading-model' || p.phase === 'isolating') && item.id === currentIdRef.current && !announcedSteps.current.has(`${item.id}:${p.phase}`)) {
              announcedSteps.current.add(`${item.id}:${p.phase}`);
              setAnnounce(p.phase === 'isolating' ? `Splitting ${item.file.name} into voice and band. This takes a few minutes.` : 'Downloading the vocal model, one time.');
            }
          },
          controller.signal,
          ...(item.isolate ? [{ isolate: item.isolate }] : []),
        )
        .then((prepared) => alive.current && !controller.signal.aborted && dispatch({ type: 'prepared', id: item.id, prepared }))
        .catch((err: unknown) => {
          if (!alive.current || controller.signal.aborted || isAbortError(err)) return; // skipped or closed: nothing to show
          dispatch({ type: 'failed', id: item.id, error: messageOf(err, `Could not read ${item.file.name}. Try another file.`) });
        })
        .finally(() => controllers.current.delete(item.id));
    };
    if (cur && cur.status === 'queued' && !started.current.has(cur.id)) start(cur);
    else if (next && cur && cur.status !== 'queued' && cur.status !== 'preparing' && next.status === 'queued' && !started.current.has(next.id)) {
      // The look-ahead starts once the file on screen has been read, and only if nothing else is being read. A file that is to be split
      // into its vocal waits for its turn instead: it runs the phone hard for minutes, which would make listening to the clip on screen stutter.
      if (!next.isolate && !state.items.some((it) => it.status === 'preparing')) start(next);
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
    if (current.status === 'preparing') setAnnounce(`Reading ${current.file.name}.`);
    else if (current.status === 'ready') setAnnounce(`${current.file.name} is ready to review.`);
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

  /** Try the same file again, with or without pulling the vocal out first. */
  const retry = (item: Item, keepIsolation: boolean) => {
    started.current.delete(item.id);
    announcedSteps.current.delete(`${item.id}:downloading-model`);
    announcedSteps.current.delete(`${item.id}:isolating`);
    dispatch({ type: 'retry', id: item.id, isolate: keepIsolation ? item.isolate : null });
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
  /** Closes for good: whatever is still being read is stopped first. */
  const closeNow = () => {
    abortAll();
    props.onClose();
  };
  const requestClose = () => {
    if (unsaved && state.step === 'work') setConfirmClose(true);
    else closeNow();
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
                <button type="button" className="button button--danger" onClick={closeNow}>
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
              {isDesktopKind(platformKind())
                ? `This browser would not give Mimic a place to keep them. ${desktopMemoryOnlyAdvice()}`
                : 'This browser would not give Mimic a place to keep them. Add the app to your Home Screen, or export a backup after adding clips.'}
            </Notice>
          )}

          {/* In a browser tab on an iPhone what is saved here is not in the Home Screen app: said before the first save, not after. */}
          {savedCount === 0 && state.step !== 'done' && <BrowserTabNote />}

          {relinkMode && !relinkClip && state.step !== 'done' && (
            <div>
              <Notice tone="error" title="That clip is no longer in the library">
                There is nothing to attach the file to. Close this and add the file as a new clip instead.
              </Notice>
              <div className="button-row">
                <button type="button" className="button button--accent" onClick={closeNow}>
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
              isolate={sep?.available && !relinkMode ? { availability: sep, value: choice, onChange: setChoice } : null}
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
              onRetry={retry}
              separation={sep}
              onReattach={reattach}
              onSkip={(id) => {
                abortItem(id);
                dispatch({ type: 'skip', id });
              }}
              onNext={() => dispatch({ type: 'next' })}
              onPickOthers={() => {
                abortAll();
                started.current.clear();
                dispatch({ type: 'reset' });
              }}
              streamSignal={() => (sheetAbort.current ??= new AbortController()).signal}
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
              onClose={closeNow}
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
  /** The vocal-isolation choice; null when the app cannot do it here (then nothing about it is shown). */
  isolate: { availability: SeparationAvailability; value: IsolateChoice; onChange(next: IsolateChoice): void } | null;
}) {
  const inputId = useId();
  const words = importWords(platformKind());
  const relink = props.relinkTitle !== null;
  const startError = props.isolate?.value.on && parseClock(props.isolate.value.start) === null ? 'Type the start as minutes and seconds, like 1:30, or leave it at 0:00.' : null;
  const blockedByChoice = startError !== null;
  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) props.onFiles(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    props.setOver(false);
    if (!props.disabled && !blockedByChoice) take(e.dataTransfer?.files);
  };
  return (
    <div>
      {relink ? (
        <p className="lede">
          Pick the file you originally added for <strong>{props.relinkTitle}</strong>
          {props.relinkFile ? ` (${props.relinkFile})` : ''}. Mimic matches it by its contents, so your phrases and scores stay as they are.
        </p>
      ) : (
        <p className="lede">{words.lede}</p>
      )}

      {props.isolate && (
        <IsolateChoiceCard manifest={props.isolate.availability.manifest} modelKept={props.isolate.availability.modelKept} value={props.isolate.value} onChange={props.isolate.onChange} startError={startError} />
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
          disabled={props.disabled || blockedByChoice}
          onChange={(e) => {
            take(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
        <label htmlFor={inputId} className="filedrop-label">
          <Icon name="upload" size={20} />
          <span className="filedrop-text">
            <span className="filedrop-title">{relink ? 'Choose the file' : 'Choose files'}</span>
            <span className="filedrop-hint">
              {props.disabled ? 'Waiting for the library to open.' : blockedByChoice ? 'Fix the start time below to choose files.' : `${words.formats} You can drop files here too.`}
            </span>
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
            {words.sheetSteps.map((s) => (
              <li key={s.title}>
                <strong>{s.title}.</strong> {s.body}
              </li>
            ))}
          </ol>
          <details className="imp-more">
            <summary>{words.videoSummary}</summary>
            <p>{words.videoHelp}</p>
          </details>
          <details className="imp-more">
            <summary>Protected songs and Apple Music</summary>
            <p>{words.protectedHelp}</p>
          </details>
          <details className="imp-more">
            <summary>No isolated vocal?</summary>
            <p>{words.stemHelp}</p>
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
  onRetry(item: Item, keepIsolation: boolean): void;
  /** Whether the app can pull a vocal out of a song here (null until asked). */
  separation: SeparationAvailability | null;
  onReattach(item: Item, existing: ClipRecord): void;
  onSkip(id: number): void;
  onNext(): void;
  onPickOthers(): void;
  /** The signal that stops reading a vocal-only file when the sheet closes. */
  streamSignal(): AbortSignal;
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
            {item.isolate && !props.relinkMode && (
              <>
                <button type="button" className="button button--accent" onClick={() => props.onRetry(item, true)}>
                  Try again
                </button>
                <button type="button" className="button" onClick={() => props.onRetry(item, false)}>
                  Add it without isolating
                </button>
              </>
            )}
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
          saving={item.status === 'saving'}
          saveError={item.saveError}
          onSave={(edits, prepared) => props.onSave(item, edits, prepared)}
          onSkip={count > 1 ? () => props.onSkip(item.id) : undefined}
          onChooseOther={props.onPickOthers}
          reanalyze={props.sheet.reanalyze ?? reanalyzeClip}
          prepareStem={(file, onProgress) => trainer.prepareClip(file, onProgress, props.streamSignal())}
          isolation={
            props.separation?.available
              ? { sizeMb: props.separation.manifest ? props.separation.manifest.bytes / (1024 * 1024) : null, modelKept: props.separation.modelKept, run: props.sheet.separation?.isolate ?? ((prepared, onProgress, signal) => isolatePrepared(prepared, onProgress, { signal })) }
              : undefined
          }
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
  const isolating = !!props.item.isolate;
  const splitting = p?.phase === 'isolating';
  const label = `${phase}: ${props.item.file.name}`;
  return (
    <div className="imp-preparing">
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
      {splitting && (
        <p className="field-hint num" aria-live="off">
          {etaWords(p?.etaSec)}
        </p>
      )}
      {p?.phase === 'downloading-model' && <p className="field-hint">{progressWords(p)}: it is kept on this {deviceNoun(platformKind())}, so this happens once.</p>}
      <p className="field-hint">
        {isolating
          ? isDesktopKind(platformKind())
            ? 'Splitting a song takes minutes and works the processor hard. Keep this tab in front and the computer awake (plug a laptop in); sleep or a locked screen can pause it.'
            : 'Splitting a song takes minutes and uses a lot of battery. Keep this screen open and the phone plugged in; locking the phone can pause it.'
          : 'A long song takes a little longer. You can leave this open.'}
      </p>
      {props.onSkip && (
        <button type="button" className="button button--ghost" onClick={props.onSkip}>
          {isolating ? 'Cancel and leave this file out' : 'Skip this file'}
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
