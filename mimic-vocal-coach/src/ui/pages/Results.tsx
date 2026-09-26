// Results: the current take scored against the selected singer, with the coaching plan, charts,
// reference-clip comparison, AI coach and exports. Switching singer re-scores the same analysis.
// A take that can't be scored (too little singing, singing over a band, too few measures) shows
// "Not scored" with the reasons and recording advice instead of a number, and can't be saved.

import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { encodeWav } from '../../audio/wav';
import { forUserVoice } from '../../coach/coach';
import { getExercise } from '../../coach/exercises';
import { compareToProfile, isScoreable, singerPassaggioLow } from '../../coach/compare';
import { STYLE_LABELS } from '../../coach/profiles';
import { useApp } from '../../state/context';
import { REFERENCE_ID, saveKey } from '../../state/reducer';
import type { CoachingItem, StyleKey, VoiceAnalysis } from '../../types';
import { DimensionMeter } from '../charts/DimensionMeter';
import { PitchPlot } from '../charts/PitchPlot';
import { RangeKeyboard } from '../charts/RangeKeyboard';
import { ReferenceDiffPlot } from '../charts/ReferenceDiffPlot';
import { RegisterBar } from '../charts/RegisterBar';
import { ScoreDial } from '../charts/ScoreDial';
import { StyleRadar } from '../charts/StyleRadar';
import { AiCoachPanel } from '../components/AiCoachPanel';
import { AnalysisProgress } from '../components/AnalysisProgress';
import { CoachingItemCard } from '../components/CoachingItemCard';
import { buildAnalysisExport, hostDownloads, saveFile, slugify, toJson } from '../components/download';
import { formatCents, formatDuration, formatTranspose, noteName, noteRange, percent } from '../components/format';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { registerTarget, userUpperShares } from '../components/registers';
import { possessive, shortName, singerColor } from '../components/singer';
import { styleDiffText } from '../components/styleDiff';

function dimensionLabel(key: CoachingItem['dimension']): string {
  if (key === 'range') return 'Range';
  if (key === 'recording') return 'Recording';
  return STYLE_LABELS[key]?.label ?? key;
}

/** ", moved 12 semitones down to your key" / ", in the same key" (transposeSemitones = user minus reference). */
function keyShiftPhrase(semitones: number): string {
  return Math.round(semitones) === 0 ? ', in the same key' : `, moved ${formatTranspose(semitones).toLowerCase()} to your key`;
}

/** Take-based key info for a reference clip with no singer behind it: "3 semitones higher" (take minus clip). */
function takeVsClip(semitones: number): string {
  const r = Math.round(semitones);
  if (!Number.isFinite(r) || r === 0) return 'About the same';
  const n = Math.abs(r);
  return `${n} semitone${n === 1 ? '' : 's'} ${r > 0 ? 'higher' : 'lower'}`;
}

/**
 * The take's tuning offset, or null when nothing measured it. The analysis reports 0 when there was
 * no pitched singing or under a second of held notes, which must not read as "in tune".
 */
export function measuredTuningCents(analysis: Pick<VoiceAnalysis, 'notes' | 'pitch'>): number | null {
  const noteSec = analysis.notes.reduce((sum, n) => sum + Math.max(0, n.end - n.start), 0);
  return analysis.pitch.medianMidi === null || noteSec < 1 ? null : analysis.pitch.tuningOffsetCents;
}

/** The coach may end a move hint with "Start here: <first step>", which the numbered steps repeat. */
export function hintWithoutFirstStep(hint: string, firstStep: string | undefined): string {
  const marker = ' Start here: ';
  const i = hint.indexOf(marker);
  if (i < 0 || !firstStep) return hint;
  const norm = (t: string) => t.replace(/[.\s]+$/, '').toLowerCase();
  return norm(hint.slice(i + marker.length)) === norm(firstStep) ? hint.slice(0, i) : hint;
}

// Stable ids per analysis or profile object, used to key the AI conversation to this take and target
// (a reference profile is rebuilt when the artist's voice type changes, which changes its key advice).
const analysisIds = new WeakMap<object, number>();
let nextAnalysisId = 1;
function analysisId(a: object): number {
  let id = analysisIds.get(a);
  if (id === undefined) {
    id = nextAnalysisId++;
    analysisIds.set(a, id);
  }
  return id;
}

function EmptyResults(props: { onStudio: () => void; onDemo: () => void; busy: boolean }) {
  return (
    <div className="page page--results">
      <header className="page-head">
        <p className="eyebrow">Results</p>
        <h1 className="page-title">No take yet</h1>
        <p className="lede">Record or upload a take in the Studio, or try the demo take, and your results will appear here.</p>
      </header>
      <div className="button-row">
        <button type="button" className="button button--accent" onClick={props.onStudio}>
          Go to the Studio
        </button>
        <button type="button" className="button button--ghost" onClick={props.onDemo} disabled={props.busy}>
          Try a demo take
        </button>
      </div>
    </div>
  );
}

export function ResultsPage() {
  const app = useApp();
  const { state, profile, profiles } = app;
  const { analysis, comparison, plan, take, referenceComparison: refComp, reference } = state;
  const saveNoteId = useId();
  // Inside the claude.ai artifact viewer files are saved through its downloads capability, which
  // takes JSON but not WAV, so the WAV button is hidden there.
  const [inHostViewer, setInHostViewer] = useState(false);
  useEffect(() => {
    let live = true;
    void hostDownloads().then((host) => live && setInHostViewer(host !== null));
    return () => {
      live = false;
    };
  }, []);

  // Each tab's score, or null when the take can't be scored against that profile.
  const tabScores = useMemo(() => {
    const out = new Map<string, number | null>();
    if (!analysis) return out;
    for (const p of profiles) {
      try {
        const c = comparison && p.id === comparison.profileId ? comparison : compareToProfile(analysis, p);
        out.set(p.id, isScoreable(analysis, c) ? c.overall : null);
      } catch {
        // A profile that cannot be scored just shows no number on its tab.
      }
    }
    return out;
  }, [analysis, comparison, profiles]);

  if (!analysis || !comparison || !plan || !profile) {
    return (
      <EmptyResults
        busy={state.status !== 'idle'}
        onStudio={() => app.go('studio')}
        onDemo={() => void app.analyzeDemo().then((ok) => ok && app.go('results'))}
      />
    );
  }

  const color = singerColor(profile);
  const name = shortName(profile);
  const style = { '--singer': color } as CSSProperties;
  const regTarget = registerTarget(profile);
  const upper = userUpperShares(analysis);
  const scoreable = isScoreable(analysis, comparison);
  const items = [...plan.items].sort((a, b) => a.priority - b.priority);
  const moves = plan.signatureFocus
    .map((f) => ({ focus: f, move: profile.signatureMoves.find((m) => m.id === f.moveId) }))
    .filter((x) => x.move);
  // The take carries its own decode notes (trimmed, cancelling channels), so a later job cannot clear them.
  const warnings = [...new Set([...analysis.warnings, ...(take?.notices ?? state.notices)])];
  const lowMidi = Math.min(40, (analysis.pitch.lowMidi ?? 40) - 2, profile.typicalRange.lowMidi - 2);
  const highMidi = Math.max(84, (analysis.pitch.highMidi ?? 84) + 2, profile.typicalRange.highMidi + 2);
  const saved = state.savedKeys.includes(saveKey(state, profile));
  const canSave = scoreable && !saved;
  const takeName = take?.name ?? 'Take';
  const tuning = measuredTuningCents(analysis);
  // The header range note is repeated word for word by a range coaching card when there is one.
  const showRangeNote = scoreable && !items.some((i) => i.dimension === 'range');
  // Key advice for builtin singers comes from the voice types; a reference clip with no singer
  // behind it can only be compared with this take, which is information rather than advice.
  const keyFromVoiceType = singerPassaggioLow(profile) !== null;
  // compareToReference returns an empty path (and NaN cents) when there is too little to line up.
  const aligned = !!refComp && refComp.path.length > 0 && Number.isFinite(refComp.meanAbsCents);
  // The comparison runs just after the result paints; say so rather than leave a gap.
  const comparingReference = !!reference?.usable && !refComp;
  const aiKey = `${analysisId(analysis)}|${profile.id}#${analysisId(profile)}|${reference?.usable ? analysisId(reference.analysis) : 0}`;
  const saveNote = !scoreable
    ? 'This take can’t be scored, so there is nothing to save yet. Record another take using the advice above.'
    : saved
      ? 'Saved. See your trend on the Progress page.'
      : 'Saving keeps only the scores and measurements, not the audio.';

  const onSave = () => {
    if (canSave) app.saveSession(takeName);
  };
  const onDownloadJson = () => {
    const data = buildAnalysisExport({
      takeName,
      source: take?.source ?? 'upload',
      analysis,
      profile,
      comparison,
      plan,
      referenceComparison: refComp,
      referenceName: reference?.name,
    });
    void saveFile(new Blob([toJson(data)], { type: 'application/json' }), `${slugify(takeName)}-${profile.id}-analysis.json`);
  };
  const onDownloadWav = () => {
    if (!take) return;
    void saveFile(new Blob([encodeWav(take.samples, take.sampleRate)], { type: 'audio/wav' }), `${slugify(takeName)}.wav`);
  };
  // aria-disabled rather than disabled, so keyboard focus stays on the button after saving.
  const saveButton = (
    <button
      type="button"
      className="button button--accent"
      onClick={onSave}
      aria-disabled={canSave ? undefined : true}
      aria-describedby={saveNoteId}
    >
      <Icon name="save" size={16} /> {saved ? 'Saved to Progress' : 'Save to progress'}
    </button>
  );
  const recordAnother = (
    <button type="button" className="button button--ghost" onClick={() => app.go('studio')}>
      <Icon name="mic" size={16} /> Record another take
    </button>
  );

  return (
    <div className="page page--results" style={style}>
      <nav className="singer-tabs" aria-label="Compare this take against">
        {profiles.map((p) => {
          const hasScore = tabScores.has(p.id);
          const score = tabScores.get(p.id);
          return (
            <button
              key={p.id}
              type="button"
              className="singer-tab"
              aria-pressed={p.id === profile.id}
              style={{ '--tab-color': singerColor(p) } as CSSProperties}
              onClick={() => app.selectProfile(p.id)}
            >
              <span className="singer-tab-name">{p.id === REFERENCE_ID ? 'Reference' : p.name}</span>
              {hasScore &&
                (score === null || score === undefined ? (
                  <span className="singer-tab-score num">
                    <span aria-hidden="true">–</span>
                    <span className="visually-hidden">not scored</span>
                  </span>
                ) : (
                  <span className="singer-tab-score num">{Math.round(score)}</span>
                ))}
            </button>
          );
        })}
      </nav>

      <header className="results-head">
        <div className="results-dial">
          {scoreable ? (
            <ScoreDial score={comparison.overall} label={`Match with ${name}`} color={color} size={176} />
          ) : (
            <div className="not-scored">
              <p className="not-scored-mark">Not scored</p>
              <p className="not-scored-note">See below for why, and what to change.</p>
            </div>
          )}
        </div>
        <div className="results-summary">
          <p className="eyebrow">{takeName}</p>
          <h1 className="page-title results-title">
            Your take vs <span className="results-title-singer">{profile.name}</span>
          </h1>
          <p className="results-headline">{plan.headline}</p>
          <dl className="facts">
            <div>
              <dt>Length</dt>
              <dd className="num">{formatDuration(analysis.durationSec)}</dd>
            </div>
            <div>
              <dt>Singing</dt>
              <dd className="num">{formatDuration(analysis.voicedSec)}</dd>
            </div>
            <div>
              <dt>Your range</dt>
              <dd className="num">{noteRange(analysis.pitch.lowMidi, analysis.pitch.highMidi)}</dd>
            </div>
            <div>
              <dt>{keyFromVoiceType ? 'Key for your voice type' : 'Your take vs the clip'}</dt>
              <dd>
                {keyFromVoiceType
                  ? formatTranspose(comparison.suggestedTransposeSemitones)
                  : takeVsClip(comparison.suggestedTransposeSemitones)}
              </dd>
            </div>
            <div>
              <dt>Tuning</dt>
              <dd className="num">
                {tuning === null ? (
                  <>
                    <span aria-hidden="true">–</span>
                    <span className="visually-hidden">not measured</span>
                  </>
                ) : (
                  formatCents(tuning)
                )}
              </dd>
            </div>
          </dl>
          {showRangeNote && <p className="range-note">{comparison.rangeNote}</p>}
          <div className="results-quick-actions">
            {saveButton}
            {recordAnother}
          </div>
        </div>
      </header>

      {state.status !== 'idle' && <AnalysisProgress status={state.status} progress={state.progress} label={state.progressLabel} />}

      {warnings.length > 0 && (
        <Notice tone="warn" title="About this recording">
          <ul className="plain-list">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}

      <section className="results-section" aria-labelledby="plan-heading">
        <div className="section-head">
          <h2 id="plan-heading" className="section-title">
            {scoreable ? 'Your coaching plan' : 'Before the next take'}
          </h2>
          <p className="section-sub">
            {scoreable
              ? `What to work on to sound more like ${name}, most important first.`
              : 'What to change so the next take can be measured and scored.'}
          </p>
        </div>
        {plan.strengths.length > 0 && (
          <div className="strengths">
            <p className="subhead">Already working</p>
            <ul className="check-list">
              {plan.strengths.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="coach-grid">
          {items.map((item) => (
            <CoachingItemCard
              key={item.id}
              item={item}
              dimensionLabel={dimensionLabel(item.dimension)}
              lookupExercise={getExercise}
              onOpenExercises={(ids) => app.openPractice(ids)}
            />
          ))}
        </div>
        {items.length === 0 && <p className="muted">Nothing pressing. Keep the same approach and try a harder phrase.</p>}
        <p className="next-take">
          <span className="subhead-inline">Next take</span> {plan.nextTake}
        </p>
      </section>

      {scoreable && (
        <section className="results-section" aria-labelledby="style-heading">
          <div className="section-head">
            <h2 id="style-heading" className="section-title">
              Style match
            </h2>
            <p className="section-sub">
              Each measure against {possessive(name)} target band. Scores are closeness, not quality: a low score only means different from
              the target.
            </p>
          </div>
          <div className="style-grid">
            <div className="style-radar">
              <StyleRadar comparison={comparison} profile={profile} size={300} />
            </div>
            <div className="meter-list">
              {comparison.dimensions.map((d) => (
                <DimensionMeter key={d.key} result={d} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="results-section" aria-labelledby="pitch-heading">
        <div className="section-head">
          <h2 id="pitch-heading" className="section-title">
            Pitch and registers
          </h2>
          <p className="section-sub">
            Your pitch over time, coloured by estimated register. The shaded band is your passaggio (
            <span className="num">{noteRange(analysis.passaggio.lowMidi, analysis.passaggio.highMidi)}</span>).
            {aligned && reference ? ` The dashed line is ${reference.name}${keyShiftPhrase(refComp.transposeSemitones)}.` : ''}
          </p>
        </div>
        <PitchPlot
          analysis={analysis}
          reference={aligned && reference ? reference.analysis : undefined}
          referenceShiftSemitones={aligned ? refComp.transposeSemitones : undefined}
          referencePath={aligned ? refComp.path : undefined}
        />
        <p className="caveat">
          Registers are estimated from acoustic cues (the balance of the first two harmonics, spectral slope, brightness, and loudness
          against pitch). They are most reliable on open vowels such as “ah”; other vowels and the microphone shift those cues, so treat
          the colours as a guide, not a diagnosis.
        </p>

        <div className="range-grid">
          <div>
            <h3 className="subhead">Range</h3>
            <RangeKeyboard
              userLow={analysis.pitch.lowMidi}
              userHigh={analysis.pitch.highMidi}
              userTessitura={
                analysis.pitch.tessituraLowMidi !== null && analysis.pitch.tessituraHighMidi !== null
                  ? [analysis.pitch.tessituraLowMidi, analysis.pitch.tessituraHighMidi]
                  : null
              }
              singerRange={profile.typicalRange}
              singerColor={color}
              passaggio={analysis.passaggio}
              fromMidi={lowMidi}
              toMidi={highMidi}
            />
          </div>
          {regTarget && (
            <div>
              <h3 className="subhead">Above the passaggio</h3>
              {upper ? (
                <RegisterBar chest={upper.chest} mix={upper.mix} head={upper.head} label="You" target={regTarget} />
              ) : (
                <p className="muted">
                  This take did not reach <span className="num">{noteName(analysis.passaggio.lowMidi)}</span>, so there
                  is no upper range to compare. Sing a phrase that climbs through your passaggio.
                </p>
              )}
              <p className="caveat">
                Share of your singing at or above <span className="num">{noteName(analysis.passaggio.lowMidi)}</span> in each register, estimated
                from the sound, against {possessive(name)} target mix.
              </p>
            </div>
          )}
        </div>
      </section>

      {moves.length > 0 && (
        <section className="results-section" aria-labelledby="moves-heading">
          <div className="section-head">
            <h2 id="moves-heading" className="section-title">
              Signature moves to try
            </h2>
          </div>
          <div className="moves">
            {moves.map(({ focus, move }) => {
              // Steps are instructions to the user, so they follow the user's voice type
              // ("head voice" rather than "falsetto" for alto, mezzo and soprano), like the plan's hints.
              const steps = move!.howTo.map((h) => forUserVoice(h, analysis));
              return (
                <article key={focus.moveId} className="move">
                  <h3 className="move-name">{move!.name}</h3>
                  <p>{move!.description}</p>
                  <p className="move-hint">{hintWithoutFirstStep(focus.hint, steps[0])}</p>
                  {steps.length > 0 && (
                    <ol className="move-steps">
                      {steps.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ol>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {scoreable && reference?.usable && (refComp || comparingReference) && (
        <section className="results-section" aria-labelledby="ref-heading">
          <div className="section-head">
            <h2 id="ref-heading" className="section-title">
              Against your reference clip
            </h2>
            {!refComp ? (
              <p className="section-sub">
                {state.error ? (
                  state.error
                ) : (
                  <>
                    Lining your take up with <strong>{reference.name}</strong>…
                  </>
                )}
              </p>
            ) : aligned ? (
              <p className="section-sub">
                Your pitch lined up with <strong>{reference.name}</strong> phrase by phrase{keyShiftPhrase(refComp.transposeSemitones)}.
              </p>
            ) : (
              <p className="section-sub">
                There is not enough pitched singing in your take or in <strong>{reference.name}</strong> to line them up phrase by phrase.
                Sing the same phrase as the clip, with a few held notes, and try again.
              </p>
            )}
          </div>
          {refComp && aligned && (
            <>
              <dl className="facts">
                <div>
                  <dt>Within 50¢</dt>
                  <dd className="num">{percent(refComp.withinFiftyCents)}</dd>
                </div>
                <div>
                  <dt>Average difference</dt>
                  <dd className="num">{Math.round(refComp.meanAbsCents)}¢</dd>
                </div>
                <div>
                  <dt>Key shift</dt>
                  <dd>{formatTranspose(refComp.transposeSemitones)}</dd>
                </div>
              </dl>
              <ReferenceDiffPlot comparison={refComp} />
              {refComp.segments.length > 0 && (
                <ol className="segment-list">
                  {refComp.segments.map((s) => (
                    <li key={`${s.userStart}-${s.refStart}`}>
                      <span className="num segment-time">
                        {formatDuration(s.userStart)}–{formatDuration(s.userEnd)}
                      </span>
                      <span className="num segment-cents">{formatCents(s.meanSignedCents)}</span>
                      <span className="segment-note">{s.note}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
          {refComp && Object.keys(refComp.styleDiff).length > 0 && (
            <>
              <h3 className="subhead">Style differences (you minus the reference)</h3>
              <ul className="diff-list">
                {(Object.entries(refComp.styleDiff) as [StyleKey, number][]).map(([k, v]) => (
                  <li key={k}>
                    <span>{STYLE_LABELS[k]?.label ?? k}</span>
                    <span className="num">{styleDiffText(k, v)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="results-section" aria-labelledby="ai-heading">
        <div className="section-head">
          <h2 id="ai-heading" className="section-title">
            Ask the AI coach
          </h2>
        </div>
        <AiCoachPanel
          settings={state.settings}
          input={{ analysis, comparison, plan, profile, reference: refComp ?? undefined }}
          conversationKey={aiKey}
          turns={state.aiThread?.key === aiKey ? state.aiThread.turns : []}
          onTurns={(key, turns) => app.dispatch({ type: 'ai/thread', key, turns })}
          onOpenSettings={() => app.go('settings')}
          singerName={name}
        />
      </section>

      <section className="results-section" aria-labelledby="health-heading">
        <div className="section-head">
          <h2 id="health-heading" className="section-title">
            Look after your voice
          </h2>
        </div>
        <ul className="health-list">
          {plan.healthNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>

      <section className="results-actions" aria-label="Save and export">
        {saveButton}
        <button type="button" className="button button--ghost" onClick={onDownloadJson}>
          <Icon name="download" size={16} /> Download analysis (JSON)
        </button>
        {!inHostViewer && (
          <button type="button" className="button button--ghost" onClick={onDownloadWav} disabled={!take}>
            <Icon name="download" size={16} /> Download take (WAV)
          </button>
        )}
        {recordAnother}
        <p id={saveNoteId} className="muted results-actions-note" aria-live="polite">
          {saveNote}
        </p>
      </section>
    </div>
  );
}
