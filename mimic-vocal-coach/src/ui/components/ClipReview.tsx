// The review of one prepared clip, before anything is stored: what Mimic found (solo vocal or full song), a way to check the
// detected melody by ear, the phrases (PhraseEditor), what part to keep, a title, who sings it, whether it counts toward that
// singer's targets (solo clips only) and the ownership tick. Save is pinned at the bottom, in thumb reach. The component owns
// the working copy of the edits and hands CommitEdits to onSave; storing is the caller's job (TrainerController.commitClip).

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { shortName, singerColor } from './singer';
import {
  blockersOf,
  defaultTitle,
  effectiveAnalysis,
  effectivePhrases,
  estimateStoredBytes,
  preparedKind,
  reanalyzeClip,
  renderContourTone,
  stemProblem,
  targetEligibility,
  withoutVocalStem,
  withVocalStem,
  type CommitEdits,
  type ImportProgress,
  type PreparedClip,
} from '../../trainer/import';
import { OWNERSHIP_LABEL, PRIVACY_NOTE, STEM_PROMPT } from '../../trainer/importCopy';
import { applyTrim, clampTrim, defaultTrim, isHidden, singingSec, visiblePhrases, type SegPhrase, type Trim } from '../../trainer/segment';
import { MEDIA_ACCEPT } from '../../audio/decode';
import type { ClipKind, SingerProfile } from '../../types';
import { formatBytes } from '../../pwa/storage';
import { Icon } from './Icon';
import { formatClock, formatDuration } from './format';
import { Notice } from './Notice';
import { PhraseEditor, formatEdgeTime } from './PhraseEditor';
import { createSamplePlayer, type SamplePlayer } from './samplePlayer';
import './clipImport.css';

const OTHER = '__other__';
/** Sample rate of the detected-melody tone (a sine with overtones does not need more). */
const MELODY_RATE = 22050;
const TRIM_STEP_SEC = 1;

export interface ClipReviewProps {
  prepared: PreparedClip;
  singers: SingerProfile[];
  /** "Clip 2 of 3". */
  position?: { index: number; count: number };
  /** The device's storage numbers, for the "will use about N MB" line. */
  storage?: { usage: number | null; quota: number | null };
  /** The ownership tick starts ticked when the user has confirmed it before. */
  ownedDefault?: boolean;
  onOwnedChange?(owned: boolean): void;
  /** Called with the edits and the clip as it is now (the reading may have been switched since it arrived). */
  onSave(edits: CommitEdits, prepared: PreparedClip): void | Promise<void>;
  /** Leave this file out (shown when there is a queue). */
  onSkip?(): void;
  saving?: boolean;
  saveError?: string | null;
  /** Something to say above the details, for example that the file is already in the library. */
  banner?: ReactNode;
  /** Re-reads the clip as solo or full song. Defaults to trainer/import reanalyzeClip. */
  reanalyze?: (prepared: PreparedClip, kind: ClipKind, onProgress?: (p: ImportProgress) => void) => Promise<PreparedClip>;
  /** Reads a second, vocal-only file for a full song. Omit to hide that option. */
  prepareStem?: (file: File, onProgress?: (p: ImportProgress) => void) => Promise<PreparedClip>;
  /** Test seam for the audio player. */
  createPlayer?: () => SamplePlayer;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ClipReview(props: ClipReviewProps) {
  const ids = useId();
  const [prep, setPrep] = useState<PreparedClip>(props.prepared);
  const kind = preparedKind(prep);
  const analysis = effectiveAnalysis(prep);
  const blockers = blockersOf(prep);

  const [phrases, setPhrases] = useState<SegPhrase[]>(() => effectivePhrases(props.prepared));
  const [edited, setEdited] = useState(false);
  const [selected, setSelected] = useState<number | null>(phrases.length > 0 ? 0 : null);
  const [title, setTitle] = useState(() => defaultTitle(props.prepared.file.name));
  const [singer, setSinger] = useState('');
  const [otherLabel, setOtherLabel] = useState('');
  const [contribute, setContribute] = useState(false);
  const [owned, setOwned] = useState(props.ownedDefault ?? false);
  const [trimChoice, setTrimChoice] = useState<Trim | null>(null);
  const [busy, setBusy] = useState<{ label: string; fraction: number | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [melody, setMelody] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [pendingKind, setPendingKind] = useState<ClipKind | null>(null);
  const [playing, setPlaying] = useState<'original' | 'melody' | null>(null);
  const [status, setStatus] = useState('');
  const playerRef = useRef<SamplePlayer | null>(null);
  const runRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // A new clip to review: start at its heading so a screen reader hears where it is.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const getPlayer = (): SamplePlayer => (playerRef.current ??= (props.createPlayer ?? createSamplePlayer)());
  useEffect(
    () => () => {
      runRef.current++;
      playerRef.current?.dispose();
      playerRef.current = null;
    },
    [],
  );

  const stopAudio = () => {
    playerRef.current?.stop();
    setPlaying(null);
  };

  // ----- the working copy

  const visible = visiblePhrases(phrases);
  const trim: Trim = trimChoice ?? defaultTrim(phrases, prep.durationSec);
  const keptVisible = visiblePhrases(applyTrim(phrases, trim)).length;
  const bytes = estimateStoredBytes(prep, trim);
  const singerProfile = props.singers.find((s) => s.id === singer) ?? null;
  const eligibility = useMemo(() => targetEligibility(prep, kind), [prep, kind]);
  const canContribute = kind === 'solo' && blockers.length === 0 && singerProfile !== null;

  const editPhrases = (next: SegPhrase[]) => {
    setPhrases(next);
    setEdited(true);
  };

  const resetFor = (next: PreparedClip) => {
    const list = effectivePhrases(next);
    setPrep(next);
    setPhrases(list);
    setSelected(list.length > 0 ? 0 : null);
    setEdited(false);
    setTrimChoice(null);
    setMelody('unknown');
    setPendingKind(null);
    setContribute(false);
  };

  const progressOf = (label: string) => (p: ImportProgress) => setBusy({ label, fraction: p.fraction });

  const chooseKind = async (next: ClipKind, confirmed = false) => {
    if (next === kind || busy) return;
    if (edited && !confirmed) {
      setPendingKind(next);
      return;
    }
    stopAudio();
    setProblem(null);
    setPendingKind(null);
    const run = ++runRef.current;
    const label = next === 'mix' ? 'Following the lead vocal in the full song' : 'Reading the clip as a solo vocal';
    setBusy({ label, fraction: 0 });
    try {
      const out = await (props.reanalyze ?? reanalyzeClip)(prep, next, progressOf(label));
      if (runRef.current !== run) return;
      resetFor(next === 'solo' ? withoutVocalStem(out) : out);
      setStatus(next === 'mix' ? 'Analysed as a full song.' : 'Analysed as a solo vocal.');
    } catch (err) {
      if (runRef.current === run) setProblem(messageOf(err, 'Mimic could not read the clip that way. Try again, or pick another file.'));
    } finally {
      if (runRef.current === run) setBusy(null);
    }
  };

  const addStem = async (file: File | undefined) => {
    if (!file || !props.prepareStem || busy) return;
    stopAudio();
    setProblem(null);
    const run = ++runRef.current;
    const label = `Reading ${file.name}`;
    setBusy({ label, fraction: 0 });
    try {
      const stem = await props.prepareStem(file, progressOf(label));
      if (runRef.current !== run) return;
      const why = stemProblem(prep, stem);
      if (why) setProblem(why);
      else {
        resetFor(withVocalStem(prep, stem));
        setStatus(`Using ${file.name} for the melody and phrases.`);
      }
    } catch (err) {
      if (runRef.current === run) setProblem(messageOf(err, 'Mimic could not read that file. Pick the vocal-only version of this song.'));
    } finally {
      if (runRef.current === run) setBusy(null);
    }
  };

  const removeStem = () => {
    stopAudio();
    resetFor(withoutVocalStem(prep));
    setProblem(null);
  };

  // ----- listening

  const phraseSamples = (i: number): { samples: Float32Array; from: number } | null => {
    const p = phrases[i];
    if (!p) return null;
    const a = Math.max(0, Math.floor(p.start * prep.sampleRate));
    const b = Math.min(prep.samples.length, Math.ceil(p.end * prep.sampleRate));
    return b > a ? { samples: prep.samples.subarray(a, b), from: a / prep.sampleRate } : null;
  };

  const playOriginal = async (i: number) => {
    const part = phraseSamples(i);
    if (!part) return;
    setProblem(null);
    setPlaying('original');
    const ok = await getPlayer().play(part.samples, prep.sampleRate, { fromSec: part.from, onEnded: () => setPlaying(null) });
    if (!ok) {
      setPlaying(null);
      setProblem('This browser could not play audio here. Check the volume and the silent switch, then try again.');
    }
  };

  const hearMelody = async () => {
    const i = selected ?? phrases.findIndex((p) => !isHidden(p));
    const p = phrases[i];
    if (!p) return;
    setProblem(null);
    const tone = renderContourTone(analysis, MELODY_RATE, { startSec: p.start, endSec: p.end });
    setPlaying('melody');
    const ok = await getPlayer().play(tone, MELODY_RATE, { fromSec: p.start, onEnded: () => setPlaying(null) });
    if (!ok) {
      setPlaying(null);
      setProblem('This browser could not play audio here. Check the volume and the silent switch, then try again.');
    }
  };

  const hearOriginal = () => {
    const i = selected ?? phrases.findIndex((p) => !isHidden(p));
    if (i >= 0) void playOriginal(i);
  };

  // ----- saving

  const reasonNotToSave = ((): string | null => {
    if (busy) return 'Wait for Mimic to finish reading the clip.';
    if (blockers.length > 0) return 'This clip cannot be saved yet. Read the message above for what to do.';
    if (visible.length === 0) return 'Show at least one phrase to practise.';
    if (keptVisible === 0) return 'The part you chose to keep has no phrase in it. Widen it.';
    if (!owned) return 'Tick the box that says the file is yours to practise with.';
    return null;
  })();

  const save = () => {
    if (reasonNotToSave !== null || props.saving) return;
    stopAudio();
    const edits: CommitEdits = {
      title: title.trim() || defaultTitle(prep.file.name),
      singerId: singerProfile ? singerProfile.id : null,
      singerLabel: singer === OTHER ? otherLabel.trim() : '',
      kind,
      phrases,
      trim,
      contributeToSinger: canContribute && eligibility.eligible && contribute,
      vocalStem: kind === 'mix' ? prep.stem : undefined,
      ownedConfirmed: true,
    };
    void props.onSave(edits, prep);
  };

  const setTrim = (next: Trim) => setTrimChoice(clampTrim(next, prep.durationSec));
  const trimStepper = (edge: 'startSec' | 'endSec', delta: number) => setTrim({ ...trim, [edge]: trim[edge] + delta });

  const sungSec = singingSec(phrases);
  const outsideTrim = visible.length - keptVisible;
  const quotaLeft = props.storage && props.storage.quota !== null && props.storage.usage !== null ? Math.max(0, props.storage.quota - props.storage.usage) : null;
  const tightOnRoom = quotaLeft !== null && bytes > quotaLeft * 0.8;
  const hasStemRoute = kind === 'mix' && !!props.prepareStem;
  const stemName = prep.stem?.file.name ?? null;
  const noticeList = [...prep.notices];

  return (
    <div className="rev" aria-labelledby={`${ids}-title`}>
      <header className="rev-head">
        {props.position && props.position.count > 1 && (
          <p className="eyebrow">
            Clip {props.position.index + 1} of {props.position.count}
          </p>
        )}
        <h3 className="rev-title" id={`${ids}-title`} ref={headingRef} tabIndex={-1}>
          Check this clip
        </h3>
        <p className="rev-file">
          <Icon name="file" size={16} />
          <span className="rev-file-name">{prep.file.name}</span>
          <span className="muted num">{formatDuration(prep.durationSec)}</span>
          {prep.sourceKind === 'video' && <span className="chip">Video</span>}
        </p>
        {blockers.length === 0 && (
          <p className="rev-stats">
            <span className="num">{visible.length}</span> phrase{visible.length === 1 ? '' : 's'} to practise, <span className="num">{Math.round(sungSec)} s</span> of singing
          </p>
        )}
      </header>

      {props.banner}
      {noticeList.map((n) => (
        <Notice key={n} tone="info">
          {n}
        </Notice>
      ))}
      {blockers.map((b) => (
        <Notice key={b} tone="error" title="This clip cannot be used yet">
          {b}
        </Notice>
      ))}
      {(prep.stem ? prep.stem.warnings : prep.warnings).map((w) => (
        <Notice key={w} tone="warn">
          {w}
        </Notice>
      ))}
      {problem && (
        <Notice tone="error" onDismiss={() => setProblem(null)}>
          {problem}
        </Notice>
      )}
      {props.saveError && (
        <Notice tone="error" title="The clip was not saved">
          {props.saveError}
        </Notice>
      )}

      {busy && (
        <div className="rev-busy" role="status">
          <p>{busy.label}</p>
          <div className="progress-track" role="progressbar" aria-label={busy.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy.fraction === null ? undefined : Math.round(busy.fraction * 100)}>
            <div className="progress-fill" style={{ width: `${Math.round((busy.fraction ?? 0.3) * 100)}%` }} />
          </div>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>

      <section className="rev-section" aria-labelledby={`${ids}-kind`}>
        <h4 className="subhead" id={`${ids}-kind`}>
          What is in this clip
        </h4>
        <label className="rev-switch">
          <input type="checkbox" role="switch" checked={kind === 'mix'} disabled={!!busy} onChange={(e) => void chooseKind(e.target.checked ? 'mix' : 'solo')} />
          <span className="rev-switch-track" aria-hidden="true" />
          <span className="rev-switch-text">
            <span className="rev-switch-title">This is a full song</span>
            <span className="rev-switch-hint">
              {kind === 'mix'
                ? 'Singing with a band. Mimic follows the lead vocal and judges pitch and timing only.'
                : prep.suggestedKind === 'mix'
                  ? 'Mimic thinks this has a band in it. Switch on to follow the lead vocal.'
                  : 'Switch on if there are instruments with the voice.'}
            </span>
          </span>
        </label>
        {pendingKind && (
          <div className="confirm" role="group" aria-label="Confirm changing how the clip is read">
            <p>Reading the clip as {pendingKind === 'mix' ? 'a full song' : 'a solo vocal'} finds the phrases again and drops the changes you made to them.</p>
            <div className="button-row">
              <button type="button" className="button button--accent" onClick={() => void chooseKind(pendingKind, true)}>
                Switch and re-detect
              </button>
              <button type="button" className="button button--ghost" onClick={() => setPendingKind(null)}>
                Keep my changes
              </button>
            </div>
          </div>
        )}
      </section>

      {hasStemRoute && (
        <section className="rev-section" aria-labelledby={`${ids}-stem`}>
          <h4 className="subhead" id={`${ids}-stem`}>
            Have the vocal on its own?
          </h4>
          {stemName ? (
            <p className="rev-stem">
              <Icon name="check" size={16} /> <strong>{stemName}</strong> is used for the melody and phrases. You still hear the whole song.{' '}
              <button type="button" className="link-button" onClick={removeStem}>
                Remove it
              </button>
            </p>
          ) : (
            <>
              <p className="field-hint">{STEM_PROMPT}</p>
              <label className="button rev-file-button">
                <Icon name="upload" size={18} />
                <span>Add the vocal-only file</span>
                <input
                  type="file"
                  className="visually-hidden"
                  accept={MEDIA_ACCEPT}
                  disabled={!!busy}
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    e.currentTarget.value = '';
                    void addStem(f);
                  }}
                />
              </label>
            </>
          )}
        </section>
      )}

      {blockers.length === 0 && phrases.length > 0 && (
        <section className="rev-section" aria-labelledby={`${ids}-melody`}>
          <h4 className="subhead" id={`${ids}-melody`}>
            Check the melody
          </h4>
          <p className="field-hint">Mimic compares you with this line. Listen to it next to the original: it should follow the singing, not the band.</p>
          <div className="button-row">
            {playing === 'melody' ? (
              <button type="button" className="button button--accent" onClick={stopAudio}>
                <Icon name="stop" size={18} />
                <span>Stop</span>
              </button>
            ) : (
              <button type="button" className="button button--accent" onClick={() => void hearMelody()}>
                <Icon name="play" size={18} />
                <span>Hear the detected melody</span>
              </button>
            )}
            <button type="button" className="button" onClick={playing === 'original' ? stopAudio : hearOriginal}>
              <Icon name={playing === 'original' ? 'stop' : 'headphones'} size={18} />
              <span>{playing === 'original' ? 'Stop' : 'Hear the original'}</span>
            </button>
          </div>
          <fieldset className="rev-verdict">
            <legend>Does the melody follow the singing?</legend>
            <div className="button-row">
              <button type="button" className="button" aria-pressed={melody === 'yes'} onClick={() => setMelody('yes')}>
                Yes
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={melody === 'no'}
                onClick={() => {
                  setMelody('no');
                  if (kind === 'solo') void chooseKind('mix');
                }}
              >
                No
              </button>
            </div>
          </fieldset>
          {melody === 'yes' && <p className="rev-ok">Good. The phrases below follow this line.</p>}
          {melody === 'no' && kind === 'mix' && (
            <p className="field-hint">
              Mimic could not follow the singing in this song.{' '}
              {hasStemRoute && !stemName ? 'Add the vocal-only file above if you have it, ' : 'Try the vocal-only version of the song, '}
              or pick another clip.
            </p>
          )}
        </section>
      )}

      {blockers.length === 0 && (
        <section className="rev-section">
          <PhraseEditor
            duration={prep.durationSec}
            phrases={phrases}
            onChange={editPhrases}
            samples={prep.samples}
            analysis={analysis}
            selected={selected}
            onSelect={(i) => {
              stopAudio();
              setSelected(i);
            }}
            trim={trim}
            onPlayPhrase={(i) => void playOriginal(i)}
            onStop={stopAudio}
            playing={playing !== null}
            getPlayhead={() => playerRef.current?.position() ?? null}
          />
        </section>
      )}

      {blockers.length === 0 && phrases.length > 0 && (
        <section className="rev-section" aria-labelledby={`${ids}-keep`}>
          <h4 className="subhead" id={`${ids}-keep`}>
            Part to keep
          </h4>
          <p className="field-hint">
            Only this part is stored, to save room. It is{' '}
            <span className="num">
              {formatEdgeTime(trim.startSec)} to {formatEdgeTime(trim.endSec)}
            </span>{' '}
            of <span className="num">{formatClock(prep.durationSec)}</span>, about <span className="num">{formatBytes(bytes)}</span> on this device.
          </p>
          <div className="rev-trim">
            <TrimStepper label="Start" value={trim.startSec} onEarlier={() => trimStepper('startSec', -TRIM_STEP_SEC)} onLater={() => trimStepper('startSec', TRIM_STEP_SEC)} />
            <TrimStepper label="End" value={trim.endSec} onEarlier={() => trimStepper('endSec', -TRIM_STEP_SEC)} onLater={() => trimStepper('endSec', TRIM_STEP_SEC)} />
          </div>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={() => setTrimChoice(null)}>
              Just the singing
            </button>
            <button type="button" className="button button--small" onClick={() => setTrim({ startSec: 0, endSec: prep.durationSec })}>
              Whole file
            </button>
          </div>
          {outsideTrim > 0 && keptVisible > 0 && (
            <p className="field-hint">
              {outsideTrim} phrase{outsideTrim === 1 ? ' is' : 's are'} outside this part and will be left out.
            </p>
          )}
          {tightOnRoom && <Notice tone="warn">This is most of the room left on this device. Keep a shorter part, or remove clips you no longer practise.</Notice>}
        </section>
      )}

      <section className="rev-section" aria-labelledby={`${ids}-details`}>
        <h4 className="subhead" id={`${ids}-details`}>
          Details
        </h4>
        <div className="field">
          <label className="field-label" htmlFor={`${ids}-name`}>
            Title
          </label>
          <input id={`${ids}-name`} className="text-input" type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
        </div>

        <fieldset className="rev-singers">
          <legend className="field-label">Who is singing?</legend>
          <div className="rev-chips">
            {props.singers.map((s) => (
              <label key={s.id} className={`rev-chip${singer === s.id ? ' rev-chip--on' : ''}`}>
                <input type="radio" name={`${ids}-singer`} checked={singer === s.id} onChange={() => setSinger(s.id)} />
                <span className="rev-dot" style={{ background: singerColor(s) }} aria-hidden="true" />
                <span>{shortName(s)}</span>
              </label>
            ))}
            <label className={`rev-chip${singer === OTHER ? ' rev-chip--on' : ''}`}>
              <input type="radio" name={`${ids}-singer`} checked={singer === OTHER} onChange={() => setSinger(OTHER)} />
              <span>Someone else</span>
            </label>
          </div>
          {singer === OTHER && (
            <div className="field">
              <label className="field-label" htmlFor={`${ids}-who`}>
                Who is it? (optional)
              </label>
              <input id={`${ids}-who`} className="text-input" type="text" value={otherLabel} maxLength={80} onChange={(e) => setOtherLabel(e.target.value)} autoComplete="off" />
            </div>
          )}
        </fieldset>

        {canContribute && singerProfile && (
          <div className="rev-targets">
            <label className={`rev-check${!eligibility.eligible ? ' rev-check--off' : ''}`}>
              <input type="checkbox" checked={contribute && eligibility.eligible} disabled={!eligibility.eligible} onChange={(e) => setContribute(e.target.checked)} />
              <span>
                <span className="rev-check-title">Add to {shortName(singerProfile)}&rsquo;s targets</span>
                <span className="rev-check-hint">
                  {eligibility.eligible
                    ? `Measures this clip and uses it to tune ${shortName(singerProfile)}'s targets in the Studio. Only numbers are kept, not audio.`
                    : (eligibility.reason ?? 'This clip cannot count toward targets.')}
                </span>
              </span>
            </label>
          </div>
        )}
      </section>

      <section className="rev-section">
        <label className="rev-check">
          <input
            type="checkbox"
            checked={owned}
            onChange={(e) => {
              setOwned(e.target.checked);
              props.onOwnedChange?.(e.target.checked);
            }}
          />
          <span>
            <span className="rev-check-title">{OWNERSHIP_LABEL}</span>
            <span className="rev-check-hint">{PRIVACY_NOTE}</span>
          </span>
        </label>
      </section>

      <footer className="rev-footer">
        {reasonNotToSave && !props.saving && (
          <p className="rev-why" id={`${ids}-why`}>
            {reasonNotToSave}
          </p>
        )}
        <div className="rev-actions">
          {props.onSkip && (
            <button type="button" className="button button--ghost" onClick={() => (stopAudio(), props.onSkip?.())} disabled={props.saving}>
              Skip this file
            </button>
          )}
          <button type="button" className="button button--accent rev-save" onClick={save} disabled={reasonNotToSave !== null || !!props.saving} aria-describedby={reasonNotToSave ? `${ids}-why` : undefined}>
            <Icon name="save" size={18} />
            <span>{props.saving ? 'Saving…' : 'Save clip'}</span>
          </button>
        </div>
      </footer>
    </div>
  );
}

function TrimStepper(props: { label: string; value: number; onEarlier(): void; onLater(): void }) {
  return (
    <div className="pe-edge" role="group" aria-label={`${props.label} of the part to keep`}>
      <span className="pe-edge-label">{props.label}</span>
      <button type="button" className="button button--ghost pe-nudge" aria-label={`${props.label} one second earlier`} onClick={props.onEarlier}>
        <span aria-hidden="true">&minus;1 s</span>
      </button>
      <span className="pe-edge-value num" aria-hidden="true">
        {formatEdgeTime(props.value)}
      </span>
      <button type="button" className="button button--ghost pe-nudge" aria-label={`${props.label} one second later`} onClick={props.onLater}>
        <span aria-hidden="true">+1 s</span>
      </button>
    </div>
  );
}
