// What you see after a take: the match (one number, with words), the four skills, how to hear it back, the next step, and
// "what to fix first". It opens at the first level (the number, the first fix and the buttons); "See more" opens the other fixes
// and the note chips, and "See everything" opens the note table, the overlay plot, the tone words and your history. It sits in the
// page below the phrase strip, so it needs no gestures and works with a keyboard and a screen reader.
//
// Honest by construction: a take that could not be scored shows no number; a score that should be doubted says so next to
// the number; a short phrase is rounded to the nearest 5 (the scorer is about twice as noisy there); tone is "not compared"
// for a full song. The number is `comparison.score.overall` and nothing else: there is no second overall.

import { useId, useState, type JSX, type ReactNode, type Ref } from 'react';
import { attemptLite } from '../../storage/library';
import { wrongNoteCount } from '../../trainer/compare';
import { keyLine } from '../../trainer/keys';
import { inOriginalTerms, type TrainerFix } from '../../trainer/feedback';
import { isShortPhrase, scoreBand } from '../../trainer/score/score';
import { MASTER_SCORE, masteryProgress, nextStep } from '../../trainer/srs';
import type { PracticeResult } from '../../trainer/engine';
import type { AttemptRecord, ClipKind, NoteCompare, PhraseRecord, SkillKey, VoiceAnalysis } from '../../types';
import { PhraseOverlayPlot } from '../charts/PhraseOverlayPlot';
import { ScoreDial } from '../charts/ScoreDial';
import { scoreTone } from '../charts/chartKit';
import { FixCard, FixList } from './FixCard';
import { Icon } from './Icon';
import { NoteTable } from './NoteTable';
import { Notice } from './Notice';
import { Spark } from './Spark';
import { TonePanel } from './TonePanel';
import { flagWord, isFlagged, noteSummary, outsideTrackerRange } from './noteWords';

export type Hear = 'original' | 'you' | 'both';
export type Detent = 1 | 2 | 3;

export interface ResultSheetProps {
  result: PracticeResult;
  /** The original phrase analysis (for the key line, the short-phrase rounding and the overlay plot). */
  reference: VoiceAnalysis | null;
  phrase: PhraseRecord;
  clipKind: ClipKind;
  /** The original is an AI-isolated vocal (ClipRecord.isolation): the tone section says its numbers are estimates. */
  isolatedReference?: boolean;
  /** Speed the take was sung at, 0.5..1. */
  rate: number;
  /** Takes made on this screen visit (3 or more offers the next phrase). */
  triesThisVisit: number;
  /** This phrase's earlier attempts, newest first, for the history and the mastery count. */
  history: readonly AttemptRecord[];
  /** `history` includes this take (it was loaded after the result). false: the mastery count is not shown yet, instead of a stale or empty one. Default true. */
  historyReady?: boolean;
  keepRecordings: boolean;
  onKeepRecordings?(on: boolean): void;
  onHear(which: Hear): void;
  /** Rendered as the primary button when given; the practice screen has Try again in its dock instead. */
  onTryAgain?(): void;
  onNext?(): void;
  onSlower?(): void;
  onFaster?(): void;
  /** Loop part of the phrase: a fix's weak region, or one note (rate 0.75). */
  onLoop?(loop: { from: number; to: number; rate: number }): void;
  onOpenExercises(ids: string[]): void;
  headingRef?: Ref<HTMLHeadingElement>;
  defaultDetent?: Detent;
}

const SKILLS: { key: SkillKey; label: string }[] = [
  { key: 'pitch', label: 'Pitch' },
  { key: 'timing', label: 'Timing' },
  { key: 'tone', label: 'Tone' },
  { key: 'expression', label: 'Expression' },
];

const BAND_WORD: Record<ReturnType<typeof scoreBand>, string> = {
  excellent: 'Very close',
  good: 'Close',
  fair: 'Getting there',
  'needs-work': 'Not there yet',
};

/** The number to show: a short phrase is rounded to the nearest 5 because the score is about twice as noisy there. */
export function shownScore(overall: number, short: boolean): number {
  const n = Math.max(0, Math.min(100, overall));
  return short ? Math.min(100, Math.round(n / 5) * 5) : Math.round(n);
}

/** True when the take has a number worth showing. */
export function isScored(result: PracticeResult): boolean {
  const s = result.comparison.score;
  return s.status === 'ok' && s.overall !== null && s.trust.level !== 'invalid';
}

/** True when the take was compared with a rough full-song guide (part of it is probably the band): the number is shown, but not as a verdict. */
export function isRoughGuide(result: PracticeResult): boolean {
  const d = result.comparison.score.diagnostics;
  return d.roughGuide === true || d.refLowConfidence === true;
}

/** The band of the shown number. The pitch score is passed so a weak pitch cannot read "Very close" on the strength of tone and expression. */
function bandOf(shown: number, result: PracticeResult): ReturnType<typeof scoreBand> {
  return scoreBand(shown, result.comparison.scores.pitch);
}

/**
 * The opening words for a score. A wrong note barely moves the number (one note in ten costs about five points), so a take with a
 * wrong note never opens with "Very close": it says it was close, with the wrong note. Against a rough guide there is no verdict word.
 */
export function leadWords(band: ReturnType<typeof scoreBand>, wrongNotes: number, rough = false): string {
  if (rough) return 'Rough guide.';
  if (wrongNotes > 0 && band === 'excellent') return wrongNotes === 1 ? 'Close, with one wrong note.' : `Close, with ${wrongNotes} wrong notes.`;
  return `${BAND_WORD[band]}.`;
}

/** One sentence for the screen reader when the result appears. */
export function resultAnnouncement(result: PracticeResult, reference: VoiceAnalysis | null): string {
  if (!isScored(result)) return `Not scored. ${result.notice ?? inOriginalTerms(result.comparison.score.notes[0] ?? 'Try again.')}`;
  const s = result.comparison.score;
  const short = reference ? isShortPhrase(reference) : false;
  const n = shownScore(s.overall as number, short);
  const first = result.fixes[0];
  const lead = leadWords(bandOf(n, result), wrongNoteCount(result.comparison), isRoughGuide(result));
  return `Score ${n} out of 100. ${lead}${first ? ` First thing to fix: ${first.title}.` : ' Nothing stood out to fix.'}`;
}

/** A Notice that is not a live region (the same look, no role): for words the page announces in its own sentence. */
function QuietNotice(props: { tone: 'info' | 'warn'; children: ReactNode }): JSX.Element {
  return (
    <div className={`notice notice--${props.tone}`}>
      <div className="notice-body">{props.children}</div>
    </div>
  );
}

function SkillRow(props: { label: string; value: number | null; why: string }): JSX.Element {
  const { value } = props;
  if (value === null) {
    return (
      <li className="rs-skill rs-skill--none">
        <span className="rs-skill-name">{props.label}</span>
        <span className="rs-skill-note">{props.why}</span>
      </li>
    );
  }
  const n = Math.round(value);
  return (
    <li className={`rs-skill rs-skill--${scoreTone(n)}`}>
      <span className="rs-skill-name">{props.label}</span>
      <span className="rs-skill-bar" aria-hidden="true">
        <span className="rs-skill-fill" style={{ width: `${Math.max(2, n)}%` }} />
      </span>
      <span className="rs-skill-n num">
        {n}
        <span className="visually-hidden"> out of 100</span>
      </span>
    </li>
  );
}

function notMeasuredWhy(skill: SkillKey, clipKind: ClipKind): string {
  if (skill === 'tone') return clipKind === 'mix' ? 'Not compared for a full song' : 'Not measured in this take';
  if (skill === 'timing') return 'Needs two or more clear notes';
  if (skill === 'expression') return 'Needs held notes';
  return 'Not measured';
}

export function ResultSheet(props: ResultSheetProps): JSX.Element {
  const { result, reference, phrase, clipKind } = props;
  const c = result.comparison;
  const s = c.score;
  const ids = { head: useId(), keep: useId() };
  const [detent, setDetent] = useState<Detent>(props.defaultDetent ?? 1);
  const [selected, setSelected] = useState<number | null>(null);

  const scored = isScored(result);
  const invalid = s.trust.level === 'invalid';
  const short = reference ? isShortPhrase(reference) : false;
  const overall = scored ? shownScore(s.overall as number, short) : null;
  const rough = isRoughGuide(result);
  const band = overall !== null ? bandOf(overall, result) : null;
  const sentence = scored ? inOriginalTerms(s.notes[0] ?? '') : '';
  const median = reference?.pitch.medianMidi ?? null;
  const fixes: TrainerFix[] = result.fixes;
  const lite = props.history.map(attemptLite);
  const mastery = masteryProgress(lite);
  const step = nextStep({ overall: scored && !rough ? (s.overall as number) : null, rate: props.rate, triesThisVisit: props.triesThisVisit, mastered: phrase.srs.rung > 0 });
  // Against a rough guide the scorer does not count unsung notes as missed (they may be the band), so they are not listed either.
  const flagged = c.notes.filter((n) => isFlagged(n) && !(rough && n.flags.every((f) => f === 'missed' || f === 'ok' || f === 'merged' || f === 'ornament')));
  // The next phrase is offered as soon as this one is as good as the mastery mark (not only after three tries), within thumb reach.
  const offerNext = step.next || (scored && !rough && (s.overall as number) >= MASTER_SCORE);

  const loopNote = (n: NoteCompare) => props.onLoop?.({ from: Math.max(0, n.refStart - 0.1), to: n.refEnd + 0.1, rate: 0.75 });
  const history = [...props.history].sort((a, b) => a.at - b.at);

  return (
    <section className="rs" aria-labelledby={ids.head}>
      <h2 id={ids.head} className="rs-title" ref={props.headingRef} tabIndex={-1}>
        {scored ? 'How close you got' : 'This take was not scored'}
      </h2>

      {/* These two say what the page's own announcement of the result already says, so they are not live regions as well. */}
      {result.notice && (
        <QuietNotice tone="warn">
          <p>{result.notice}</p>
        </QuietNotice>
      )}
      {!result.notice && !scored && (
        <QuietNotice tone="info">
          <p>{inOriginalTerms(s.notes[0] ?? 'Mimic could not line this take up with the phrase. Listen to it once more, then try again.')}</p>
        </QuietNotice>
      )}
      {scored && s.trust.level === 'caution' && inOriginalTerms(s.trust.reasons[0] ?? '') !== result.notice && (
        <Notice tone="warn" title="Treat this score with care">
          <p>{inOriginalTerms(s.trust.reasons[0] ?? 'The take was unclear in places.')}</p>
        </Notice>
      )}
      {c.bleedSuspect && !invalid && (
        <Notice tone="warn" title="This sounds close to the playback">
          <p>If the guide was playing through the speaker, the microphone may have heard it. Use headphones, or choose Listen, then sing.</p>
        </Notice>
      )}

      {scored && overall !== null && band && (
        <div className="rs-top">
          <div className="rs-dial">
            <ScoreDial score={overall} label="Match" size={88} color={`var(--${scoreTone(overall)})`} />
          </div>
          <div className="rs-top-text">
            <p className="rs-sentence">
              <strong>{leadWords(band, wrongNoteCount(c), rough)}</strong> {sentence}
            </p>
            {short && <p className="rs-hint">Short phrases are scored roughly, so the number is rounded to the nearest 5.</p>}
            {median !== null && <p className="rs-key">{keyLine(median, c.transposeSemitones)}</p>}
            {c.syncOffsetMs !== null && (
              <p className="rs-hint">
                Sync offset <span className="num">{Math.round(c.syncOffsetMs)} ms</span>
                {c.syncConfidence === 'low' ? ' (rough)' : ''}: your headphones plus your reaction. Not counted against you.
              </p>
            )}
          </div>
        </div>
      )}

      {scored && (
        <ul className="rs-skills" aria-label="Your four skills">
          {SKILLS.map((k) => (
            <SkillRow key={k.key} label={k.label} value={s.skills[k.key]} why={notMeasuredWhy(k.key, clipKind)} />
          ))}
        </ul>
      )}

      <div className="rs-hear" role="group" aria-label="Hear it back">
        <button type="button" className="button" onClick={() => props.onHear('original')}>
          <Icon name="headphones" size={16} /> Original
        </button>
        <button type="button" className="button" onClick={() => props.onHear('you')} disabled={invalid}>
          <Icon name="mic" size={16} /> You
        </button>
        <button type="button" className="button" onClick={() => props.onHear('both')} disabled={invalid}>
          <Icon name="headphones" size={16} /> Both
        </button>
      </div>

      <div className="rs-next">
        {props.onTryAgain && (
          <button type="button" className="button button--accent" onClick={props.onTryAgain}>
            Try again
          </button>
        )}
        {step.slower && props.onSlower && (
          <button type="button" className="button" onClick={props.onSlower}>
            Try it at 75%
          </button>
        )}
        {step.faster && props.onFaster && (
          <button type="button" className="button" onClick={props.onFaster}>
            Back to full speed
          </button>
        )}
        {offerNext && props.onNext && (
          <button type="button" className="button" onClick={props.onNext}>
            Next phrase <Icon name="forward" size={16} />
          </button>
        )}
      </div>

      {/* Not a live region: the page already announces the score. Shown once the history includes this take. */}
      {scored && props.historyReady !== false && (
        <p className="rs-mastery">
          {rough
            ? 'This take was compared with a rough guide, so it does not count toward mastery. A vocal-only file gives a real score.'
            : phrase.srs.rung > 0
            ? 'Mastered. It will come back for review.'
            : mastery.considered === 0
              ? `Counts toward mastery when sung at full speed: ${mastery.needed} good tries are needed.`
              : `${mastery.hits} of ${mastery.needed} good tries at full speed so far. A good try is 85 or more with no wrong note.`}
        </p>
      )}

      {scored && (
        <div className="rs-fixes">
          <h3 className="rs-sub">What to fix first</h3>
          {fixes.length === 0 ? (
            <FixList fixes={[]} onOpenExercises={props.onOpenExercises} />
          ) : (
            <>
              <FixCard fix={fixes[0]} rank={0} onOpenExercises={props.onOpenExercises} onLoop={props.onLoop ? (loop) => props.onLoop?.(loop) : undefined} />
              {detent >= 2 &&
                fixes.slice(1).map((f, i) => <FixCard key={f.id} fix={f} rank={i + 1} onOpenExercises={props.onOpenExercises} onLoop={props.onLoop ? (loop) => props.onLoop?.(loop) : undefined} />)}
            </>
          )}
        </div>
      )}

      {detent >= 2 && scored && c.notes.length > 0 && (
        <div className="rs-chips">
          <h3 className="rs-sub">Note by note</h3>
          <ul className="rs-notechips">
            {c.notes.map((n) => {
              const bad = n.flags.find((f) => flagWord(f) !== null);
              // Against a rough guide a note that was not sung may be the band, not the singer: the scorer does not count it as missed, so it is not called missed here either.
              const notCounted = rough && bad === 'missed';
              const shown = notCounted ? null : bad;
              return (
                <li key={n.refIndex}>
                  <button
                    type="button"
                    className={`rs-notechip${shown ? ' rs-notechip--flag' : ''}`}
                    onClick={() => loopNote(n)}
                    disabled={!props.onLoop || outsideTrackerRange(n)}
                    aria-label={`${notCounted ? `${n.refName}: not counted against a rough guide` : noteSummary(n)}${props.onLoop ? '. Loops this note at 75 percent.' : ''}`}
                  >
                    <Icon name={shown ? 'alert' : notCounted ? 'info' : 'check'} size={14} />
                    <span className="num rs-notechip-name">{n.refName}</span>
                    <span className="rs-notechip-word">{shown ? flagWord(shown) : notCounted ? 'not counted' : 'ok'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {flagged.length === 0 && <p className="rs-hint">Every note was inside the marks.</p>}
        </div>
      )}

      {detent >= 3 && scored && (
        <div className="rs-all">
          <h3 className="rs-sub">Each note</h3>
          <NoteTable comparison={c} selected={selected} onSelect={(n) => (setSelected(n.refIndex), loopNote(n))} actionHint="Loops this note at 75 percent" />
          {reference && (
            <>
              <h3 className="rs-sub">Your line over the original</h3>
              <PhraseOverlayPlot reference={reference} comparison={c} keyMode={result.keyMode} selectedNote={selected} onSelectNote={setSelected} />
            </>
          )}
          <h3 className="rs-sub">Tone, in words</h3>
          <TonePanel comparison={c} referenceKind={clipKind} isolatedReference={props.isolatedReference} />

          <h3 className="rs-sub">This phrase so far</h3>
          <p className="rs-history">
            {phrase.stats.best !== null && (
              <>
                Best <span className="num">{Math.round(phrase.stats.best)}</span> ·{' '}
              </>
            )}
            <span className="num">{phrase.stats.attempts}</span> {phrase.stats.attempts === 1 ? 'try' : 'tries'}
            {history.length > 0 && (
              <>
                {' '}
                · last {Math.min(5, history.length)} <Spark scores={history.map((h) => h.scores.overall)} />
              </>
            )}
          </p>

          {props.onKeepRecordings && (
            <div className="rs-keep">
              <label className="tr-switch" htmlFor={ids.keep}>
                <input id={ids.keep} type="checkbox" role="switch" checked={props.keepRecordings} onChange={(e) => props.onKeepRecordings?.(e.currentTarget.checked)} />
                <span className="tr-switch-label">Keep my recordings of this phrase</span>
              </label>
              <p className="field-hint">When on, the last three takes of each phrase stay on this device so you can play them back. They are never uploaded.</p>
            </div>
          )}
        </div>
      )}

      {scored && (
        <div className="rs-more-row">
          {detent < 3 ? (
            <button
              type="button"
              className="button button--ghost rs-more"
              aria-expanded={detent > 1}
              onClick={() => setDetent((d) => (d === 1 ? 2 : 3))}
            >
              <Icon name="chevron-down" size={16} /> {detent === 1 ? 'See more' : 'See everything'}
            </button>
          ) : null}
          {detent > 1 && (
            <button type="button" className="button button--ghost rs-more" onClick={() => setDetent((d) => (d === 3 ? 2 : 1))}>
              <Icon name="chevron-up" size={16} /> {detent === 3 ? 'Show less' : 'Hide the detail'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
