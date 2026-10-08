// One clip: its title, singer, whether it counts toward that singer's measured targets, and the list of phrases to practise.
// "Edit phrases" opens the phrase editor (merge, split, move edges, hide short bits); phrases that keep their id keep their
// history, new ones start fresh. Everything goes through the TrainerController.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ROUGH_GUIDE_PURITY } from '../../analysis/leadTrust';
import { mixTrustBand } from '../../analysis/quality';
import { MAX_CLIPS_PER_SINGER } from '../../coach/measured';
import { contributionBlocker } from '../../storage/library';
import { goTrainer, trainerHash } from '../../state/routing';
import { useTrainer } from '../../state/trainerContext';
import { newPhraseId } from '../../trainer/import';
import { ISOLATED_KIND_LABEL, ISOLATED_TARGETS_NOTE, ISOLATED_TONE_NOTE } from '../../trainer/importCopy';
import { remapPhraseRecords, segmentsFromRecords, validatePhrases, type SegPhrase } from '../../trainer/segment';
import type { ClipRecord, PhraseRecord } from '../../types';
import { Icon } from '../components/Icon';
import { ImportSheet } from '../components/ImportSheet';
import { Notice } from '../components/Notice';
import { PhraseEditor } from '../components/PhraseEditor';
import { Spark } from '../components/Spark';
import { StatusChip } from '../components/StatusChip';
import { clipColor } from '../components/ClipCard';
import { noteRange } from '../components/format';
import { clipLength, phraseCount, phraseLength, phraseNumber, phraseStatus, STATUS_LABEL, summariseClip, visiblePhrases } from '../components/phraseStatus';
import { createSamplePlayer, type SamplePlayer } from '../components/samplePlayer';
import { clearPendingImport } from '../trainerHandoff';
import { singerName, singerOf, useFocusOnMount } from './trainerKit';
import { useClipAudio } from './useClipAudio';

const LEAD_WORDS = { high: 'followed well', ok: 'followed fairly well', low: 'hard to follow in places', poor: 'very hard to follow' } as const;

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function PhraseRow(props: { clip: ClipRecord; phrase: PhraseRecord; now: number }) {
  const { clip, phrase: p, now } = props;
  const n = phraseNumber(p);
  const status = phraseStatus(p, now);
  const sum = p.summary;
  return (
    <a className={`cp${p.hidden ? ' cp--hidden' : ''}`} href={trainerHash({ view: 'phrase', clipId: clip.id, phraseNumber: n })}>
      <span className="cp-n num" aria-hidden="true">
        {n}
      </span>
      <span className="cp-main">
        <span className="cp-label">{p.label || `Phrase ${n}`}</span>
        <span className="cp-meta">
          <span className="num">{phraseLength(p.voicedEnd - p.voicedStart)}</span>
          {sum && sum.lowMidi !== null && sum.highMidi !== null && (
            <>
              {/* Seen as a dot; read (and named) as a comma, so the card is "7.3 s, G3–E4" and not "7.3 sG3–E4". */}
              <span aria-hidden="true"> · </span>
              <span className="visually-hidden">, </span>
              <span className="num">{noteRange(sum.lowMidi, sum.highMidi)}</span>
            </>
          )}
          {p.lyrics && <span className="cp-lyrics"> · {p.lyrics}</span>}
        </span>
      </span>
      <span className="cp-right">
        <StatusChip status={status} />
        {p.stats.best !== null && (
          <span className="cp-best">
            best <span className="num">{Math.round(p.stats.best)}</span>
          </span>
        )}
        <Spark scores={p.stats.recent} />
      </span>
    </a>
  );
}

export function ClipView(props: { clipId: string; now: number; focusHeading: boolean }) {
  const trainer = useTrainer();
  const { now } = props;
  const clip = trainer.getClip(props.clipId);
  const headingRef = useFocusOnMount<HTMLHeadingElement>(props.focusHeading);
  const ids = { rename: useId(), other: useId(), notes: useId(), singer: useId() };

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [label, setLabel] = useState(clip?.singerLabel ?? '');
  const [notesDraft, setNotesDraft] = useState(clip?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<SegPhrase[] | null>(null);
  const [relinking, setRelinking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const editHeading = useRef<HTMLHeadingElement>(null);
  // The waveform and pitch line under the phrase editor, and a way to hear a phrase: loaded only while the editor is open.
  const editorAudio = useClipAudio(trainer, clip, editing !== null);
  const playerRef = useRef<SamplePlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const stopPlayback = () => {
    playerRef.current?.stop();
    setPlaying(false);
  };
  useEffect(
    () => () => {
      playerRef.current?.dispose();
      playerRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (editing === null) stopPlayback();
  }, [editing]);

  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);
  // Follow the stored value when it changes somewhere else (another tab, an import).
  const storedLabel = clip?.singerLabel;
  useEffect(() => setLabel(storedLabel ?? ''), [storedLabel]);
  const storedNotes = clip?.notes;
  useEffect(() => setNotesDraft(storedNotes ?? ''), [storedNotes]);

  const summary = useMemo(() => (clip ? summariseClip(clip, now) : null), [clip, now]);

  if (!clip || !summary) {
    const loading = trainer.status === 'loading';
    return (
      <div className="page page--clip">
        <a className="back-link" href="#trainer">
          <Icon name="back" size={18} /> All clips
        </a>
        <header className="page-head">
          <h1 className="page-title" ref={headingRef} tabIndex={-1}>
            {loading ? 'Opening your library…' : 'That clip is not in your library'}
          </h1>
          {!loading && (
            <p className="lede">
              It may have been deleted, or this link came from another device. Open the library to see the clips on this device, or add the clip again.
            </p>
          )}
        </header>
        {!loading && (
          <div className="button-row">
            <a className="button button--accent" href="#trainer">
              Back to the library
            </a>
            <a className="button button--ghost" href="#trainer/add">
              Add clips
            </a>
          </div>
        )}
      </div>
    );
  }

  const singer = singerOf(clip, trainer.singers);
  const who = singerName(clip, trainer.singers);
  const blocker = contributionBlocker(clip);
  const counted = singer ? trainer.clips.filter((c) => c.contributesToSinger && c.singerId === singer.id).length : 0;
  const visible = visiblePhrases(clip);
  const hidden = clip.phrases.filter((p) => p.hidden);
  const firstOpen = visible.find((p) => {
    const st = phraseStatus(p, now);
    return st !== 'mastered';
  });
  const start = firstOpen ?? visible[0];
  const startsAtFirst = !start || start.id === visible[0]?.id;

  // While a change is being saved the controls stay where they are (aria-disabled, not disabled), so the one just pressed keeps keyboard
  // and VoiceOver focus; this guard is what makes them inert.
  const run = async (task: () => Promise<void>, done?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
      if (done) setStatus(done);
    } catch (err) {
      setError(messageOf(err, 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = async () => {
    const title = draft.trim();
    if (!title) {
      setError('Give the clip a name.');
      renameInput.current?.focus();
      return;
    }
    if (title === clip.title) {
      setRenaming(false);
      requestAnimationFrame(() => renameButton.current?.focus());
      return;
    }
    await run(async () => {
      await trainer.updateClip(clip.id, { title });
      setRenaming(false);
      requestAnimationFrame(() => renameButton.current?.focus());
    }, 'Renamed.');
  };

  const pickSinger = (id: string | null) => {
    if ((id === null && clip.singerId === null) || id === clip.singerId) return;
    void run(() => trainer.updateClip(clip.id, id === null ? { singerId: null } : { singerId: id }), id === null ? 'Marked as someone else.' : 'Singer changed.');
  };

  const saveLabel = () => {
    if (label.trim() === clip.singerLabel.trim()) return;
    void run(() => trainer.updateClip(clip.id, { singerLabel: label }), 'Name saved.');
  };

  const saveNotes = () => {
    if (notesDraft === clip.notes) return;
    void run(() => trainer.updateClip(clip.id, { notes: notesDraft }), 'Notes saved.');
  };

  const toggleTargets = (on: boolean) => void run(() => trainer.setContributes(clip.id, on), on ? `Counting toward ${who}'s targets.` : 'No longer counting toward targets.');

  const beginEdit = () => {
    if (busy) return;
    setError(null);
    setEditing(segmentsFromRecords(clip.phrases));
    // The Edit phrases button leaves with the page it was on: focus the editor's heading, not <body>.
    requestAnimationFrame(() => editHeading.current?.focus());
  };

  const playPhrase = async (index: number) => {
    const p = editing?.[index];
    const { samples, sampleRate } = editorAudio;
    if (!p || !samples) return;
    const from = Math.max(0, Math.floor(p.start * sampleRate));
    const to = Math.min(samples.length, Math.ceil(p.end * sampleRate));
    if (to <= from) return;
    const player = (playerRef.current ??= createSamplePlayer());
    setPlaying(true);
    const ok = await player.play(samples.subarray(from, to), sampleRate, { fromSec: from / sampleRate, onEnded: () => setPlaying(false) });
    if (!ok) {
      setPlaying(false);
      setError('This browser could not play audio here. Check the volume and the silent switch, then try again.');
    }
  };

  const cancelEdit = () => {
    if (busy) return;
    stopPlayback();
    setEditing(null);
    requestAnimationFrame(() => editButton.current?.focus());
  };

  const problems = editing ? validatePhrases(editing, clip.durationSec) : [];

  const saveEdit = async () => {
    if (!editing || problems.length > 0) return;
    const { phrases, dropped } = remapPhraseRecords(clip.phrases, editing, null, newPhraseId);
    await run(async () => {
      await trainer.updatePhrases(clip.id, phrases);
      for (const phraseId of dropped) await trainer.deleteAttempts({ phraseId });
      stopPlayback();
      setEditing(null);
      requestAnimationFrame(() => editButton.current?.focus());
    }, dropped.length > 0 ? `Phrases saved. ${dropped.length} changed ${dropped.length === 1 ? 'phrase' : 'phrases'} started fresh.` : 'Phrases saved.');
  };

  const deleteClip = async () => {
    await run(async () => {
      await trainer.deleteClip(clip.id);
      goTrainer({ view: 'library' });
    });
  };

  const color = clipColor(singer);
  const typeWord = clip.kind === 'mix' ? 'Full song' : clip.isolation ? ISOLATED_KIND_LABEL : 'Solo vocal';

  return (
    <div className="page page--clip">
      <a className="back-link" href="#trainer">
        <Icon name="back" size={18} /> All clips
      </a>

      <header className="page-head">
        <p className="eyebrow cl-singer">
          <span className="cl-dot" style={{ background: color }} aria-hidden="true" />
          {who}
        </p>
        {renaming ? (
          <form
            className="cl-rename"
            onSubmit={(e) => {
              e.preventDefault();
              void saveTitle();
            }}
          >
            <label className="field-label" htmlFor={ids.rename}>
              Clip name
            </label>
            <div className="input-row">
              <input
                ref={renameInput}
                id={ids.rename}
                className="text-input"
                value={draft}
                maxLength={120}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    requestAnimationFrame(() => renameButton.current?.focus());
                  }
                }}
              />
              <button type="submit" className="button button--accent" aria-disabled={busy || undefined}>
                Save
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setRenaming(false);
                  requestAnimationFrame(() => renameButton.current?.focus());
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="cl-titlerow">
            <h1 className="page-title" ref={headingRef} tabIndex={-1}>
              {clip.title}
            </h1>
            <button
              ref={renameButton}
              type="button"
              className="icon-button cl-rename-btn"
              onClick={() => {
                setDraft(clip.title);
                setError(null);
                setRenaming(true);
              }}
              aria-label={`Rename ${clip.title}`}
            >
              <Icon name="edit" size={18} />
            </button>
          </div>
        )}
        <p className="lede">
          <span className="num">{phraseCount(summary.total)}</span> · <span className="num">{clipLength(clip.durationSec)}</span> · {typeWord}
          {clip.kind === 'mix' && ' (pitch and timing only)'}
        </p>
      </header>

      <p className="visually-hidden" role="status">
        {status}
      </p>
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          <p>{error}</p>
        </Notice>
      )}

      {clip.audioMissing && (
        <Notice tone="warn" title="This clip needs its audio again">
          <p>
            The phrases and scores came back from a backup, but the sound itself is not on this device. Pick the same file again and Mimic will reconnect it without
            changing your phrases.
          </p>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={() => setRelinking(true)}>
              <Icon name="file" size={16} /> Pick the file
            </button>
          </div>
        </Notice>
      )}

      {clip.isolation && (
        <Notice tone="info" title={ISOLATED_KIND_LABEL}>
          <p>{ISOLATED_TONE_NOTE}</p>
          <p className="field-hint">
            Made on this device by {clip.isolation.model} ({clip.isolation.version}){clip.isolation.sourceStartSec > 0 ? `, from ${Math.floor(clip.isolation.sourceStartSec / 60)}:${String(Math.round(clip.isolation.sourceStartSec % 60)).padStart(2, '0')} in the song` : ''}.
          </p>
        </Notice>
      )}

      {clip.kind === 'mix' && (
        <Notice tone="info" title="A full song">
          <p>Mimic follows the lead vocal, so pitch and timing are scored; the tone of the voice is not compared because the band changes it.</p>
          {typeof clip.analysis.leadConfidence === 'number' && (
            <p className="field-hint">
              When you added it, Mimic rated how well it followed the singing as <strong>{LEAD_WORDS[mixTrustBand({ confidence: clip.analysis.leadConfidence, purity: clip.analysis.leadPurity })]}</strong> (
              {clip.analysis.leadConfidence.toFixed(2)} out of 1, a ranking rather than a measured accuracy).
              {typeof clip.analysis.leadPurity === 'number' && clip.analysis.leadPurity < ROUGH_GUIDE_PURITY
                ? ' About a third or more of what was followed is probably the band, so scores against it are a rough guide and do not count toward mastery.'
                : ''}
              {clip.analysisKind === 'mix-melody' ? ' Edit the phrases if the melody missed part of a line.' : ''}
            </p>
          )}
        </Notice>
      )}

      {editing === null ? (
        <>
          <div className="cl-summary" aria-label="Where you are with this clip">
            <p className="cl-summary-main">
              <span className="num">{summary.mastered}</span> of <span className="num">{summary.total}</span> mastered
            </p>
            <p className="cl-summary-detail">
              {[
                summary.reviewDue > 0 ? `${summary.reviewDue} to review` : null,
                summary.learning > 0 ? `${summary.learning} ${STATUS_LABEL.learning.toLowerCase()}` : null,
                summary.stuck > 0 ? `${summary.stuck} stuck` : null,
                summary.fresh > 0 ? `${summary.fresh} new` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Nothing tried yet'}
            </p>
          </div>

          {visible.length > 0 && (
            <div className="cl-bands" aria-hidden="true">
              {visible.map((p) => (
                <span key={p.id} className={`cl-band cl-band--${phraseStatus(p, now)}`} style={{ flexGrow: Math.max(0.5, p.end - p.start) }} />
              ))}
            </div>
          )}

          <div className="cl-actions">
            {start && !clip.audioMissing ? (
              <a className="button button--accent cl-practise" href={trainerHash({ view: 'phrase', clipId: clip.id, phraseNumber: phraseNumber(start) })}>
                <Icon name="play" size={14} /> {startsAtFirst ? 'Practise in order' : `Continue from phrase ${phraseNumber(start)}`}
              </a>
            ) : (
              <span className="field-hint">{clip.audioMissing ? 'Add the file again to practise.' : 'This clip has no phrases to practise. Use Edit phrases to add one.'}</span>
            )}
            <button ref={editButton} type="button" className="button button--ghost" onClick={beginEdit} aria-disabled={busy || undefined}>
              <Icon name="edit" size={16} /> Edit phrases
            </button>
          </div>

          <section className="cl-section" aria-labelledby="cl-phrases-h">
            <h2 id="cl-phrases-h" className="section-title">
              Phrases
            </h2>
            {visible.length === 0 ? (
              <p className="viz-empty">There are no visible phrases in this clip. Open Edit phrases to bring back the short bits or to draw a phrase yourself.</p>
            ) : (
              <ol className="cl-phrases">
                {visible.map((p) => (
                  <li key={p.id}>
                    <PhraseRow clip={clip} phrase={p} now={now} />
                  </li>
                ))}
              </ol>
            )}
            {hidden.length > 0 && (
              <details className="cl-hidden">
                <summary>
                  Show {hidden.length} short {hidden.length === 1 ? 'bit' : 'bits'}
                </summary>
                <ol className="cl-phrases">
                  {hidden.map((p) => (
                    <li key={p.id}>
                      <PhraseRow clip={clip} phrase={p} now={now} />
                    </li>
                  ))}
                </ol>
                <p className="caveat">Short bits are left out of today&apos;s list. Open one to practise it anyway.</p>
              </details>
            )}
          </section>
        </>
      ) : (
        <section className="cl-section" aria-labelledby="cl-edit-h">
          <h2 id="cl-edit-h" ref={editHeading} tabIndex={-1} className="section-title">
            Edit phrases
          </h2>
          <p className="section-sub">
            Select a phrase, then merge it with the next one, split it, move its edges or hide it. A phrase whose edges you move keeps its history; a phrase you split or merge starts fresh.
          </p>
          {editorAudio.status === 'loading' && (
            <p className="field-hint" role="status">
              Loading the waveform…
            </p>
          )}
          {editorAudio.status === 'error' && (
            <p className="field-hint" role="status">
              The waveform could not be loaded ({editorAudio.message}). You can still edit the phrases with the buttons.
            </p>
          )}
          <PhraseEditor
            duration={clip.durationSec}
            phrases={editing}
            onChange={setEditing}
            samples={editorAudio.samples}
            analysis={editorAudio.analysis}
            onPlayPhrase={editorAudio.samples ? (i) => void playPhrase(i) : undefined}
            onStop={stopPlayback}
            playing={playing}
            getPlayhead={() => playerRef.current?.position() ?? null}
          />
          {problems.length > 0 && (
            <Notice tone="warn" title="Fix this before saving">
              <ul className="plain-list">
                {problems.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={() => void saveEdit()} aria-disabled={busy || problems.length > 0 || undefined}>
              <Icon name="save" size={16} /> Save phrases
            </button>
            <button type="button" className="button button--ghost" onClick={cancelEdit} aria-disabled={busy || undefined}>
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="cl-section" aria-labelledby="cl-about-h">
        <h2 id="cl-about-h" className="section-title">
          About this clip
        </h2>

        <fieldset className="cl-singers">
          <legend className="field-label">Whose voice is it?</legend>
          <div className="tr-filter" role="group" aria-label="Singer">
            {trainer.singers.map((s) => (
              <button key={s.id} type="button" className="tr-chip" aria-pressed={clip.singerId === s.id} onClick={() => pickSinger(s.id)} aria-disabled={busy || undefined}>
                {s.name}
              </button>
            ))}
            <button type="button" className="tr-chip" aria-pressed={clip.singerId === null} onClick={() => pickSinger(null)} aria-disabled={busy || undefined}>
              Someone else
            </button>
          </div>
          {clip.singerId === null && (
            <div className="field">
              <label className="field-label" htmlFor={ids.other}>
                Their name (optional)
              </label>
              <input
                id={ids.other}
                className="text-input"
                value={label}
                maxLength={60}
                onChange={(e) => setLabel(e.currentTarget.value)}
                onBlur={saveLabel}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveLabel();
                  }
                }}
              />
            </div>
          )}
        </fieldset>

        <div className="cl-targets">
          <label className="tr-switch">
            <input
              type="checkbox"
              role="switch"
              checked={clip.contributesToSinger}
              disabled={blocker !== null && !clip.contributesToSinger}
              aria-disabled={busy || undefined}
              onChange={(e) => toggleTargets(e.currentTarget.checked)}
              aria-describedby={`${ids.singer}-hint`}
            />
            <span className="tr-switch-label">Counts toward {singer ? `${singer.name.split(' ')[0]}'s` : 'a singer’s'} measured targets</span>
          </label>
          <p id={`${ids.singer}-hint`} className="field-hint">
            {clip.contributesToSinger && singer
              ? `Its measurements shape ${singer.name}'s targets in the Studio. ${counted} of ${MAX_CLIPS_PER_SINGER} clips count.`
              : blocker ?? `Turn on to let this clip's measurements shape ${singer?.name ?? 'the singer'}'s targets in the Studio. Only the numbers are used, never the audio.`}
            {clip.isolation ? ` ${ISOLATED_TARGETS_NOTE}` : ''}
          </p>
        </div>

        <div className="field">
          <label className="field-label" htmlFor={ids.notes}>
            Notes
          </label>
          <textarea
            id={ids.notes}
            className="text-input cl-notes"
            rows={3}
            maxLength={2000}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.currentTarget.value)}
            onBlur={saveNotes}
            placeholder="Where it is from, what to listen for…"
          />
        </div>
        <p className="caveat">
          Added from <span className="num">{clip.sourceFileName}</span>. You confirmed it is a file you own or may practise with; it stays on this device.
        </p>
      </section>

      <section className="cl-section cl-danger" aria-labelledby="cl-delete-h">
        <h2 id="cl-delete-h" className="section-title">
          Remove this clip
        </h2>
        {confirmDelete ? (
          <div className="confirm" role="group" aria-labelledby="cl-delete-q">
            <p id="cl-delete-q">Delete this clip, its phrases and every practice score from this device? This cannot be undone.</p>
            <div className="button-row">
              <button type="button" className="button button--danger" onClick={() => void deleteClip()} aria-disabled={busy || undefined}>
                Yes, delete the clip
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => {
                  setConfirmDelete(false);
                  requestAnimationFrame(() => deleteButton.current?.focus());
                }}
                autoFocus
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button ref={deleteButton} type="button" className="button button--danger" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={16} /> Delete clip
          </button>
        )}
      </section>

      {relinking && (
        <ImportSheet
          relinkClipId={clip.id}
          onClose={() => {
            clearPendingImport();
            setRelinking(false);
          }}
        />
      )}
    </div>
  );
}
