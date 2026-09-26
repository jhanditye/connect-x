// Results: the current take scored against the selected singer, with the coaching plan, charts,
// reference-clip comparison, AI coach and exports. Switching singer re-scores the same analysis.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { encodeWav } from '../../audio/wav';
import { getExercise } from '../../coach/exercises';
import { compareToProfile } from '../../coach/compare';
import { STYLE_LABELS } from '../../coach/profiles';
import { useApp } from '../../state/context';
import { REFERENCE_ID } from '../../state/reducer';
import type { CoachingItem, StyleKey } from '../../types';
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
import { buildAnalysisExport, downloadBlob, slugify, toJson } from '../components/download';
import { formatCents, formatDuration, formatTranspose, noteName, noteRange, percent, signed } from '../components/format';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { registerTarget, userUpperShares } from '../components/registers';
import { possessive, shortName, singerColor } from '../components/singer';

function dimensionLabel(key: CoachingItem['dimension']): string {
  if (key === 'range') return 'Range';
  if (key === 'recording') return 'Recording';
  return STYLE_LABELS[key]?.label ?? key;
}

function styleDiffText(key: StyleKey, diff: number): string {
  const meta = STYLE_LABELS[key];
  const digits = Math.abs(diff) >= 10 ? 0 : Math.abs(diff) >= 1 ? 1 : 2;
  const unit = meta?.unit ? ` ${meta.unit}` : '';
  const toward = diff > 0 ? meta?.highWord : meta?.lowWord;
  return `${signed(diff, digits)}${unit}${toward && Math.abs(diff) > 0 ? `, toward ${toward}` : ''}`;
}

/** ", moved 12 semitones down to your key" / ", in the same key" (transposeSemitones = user minus reference). */
function keyShiftPhrase(semitones: number): string {
  return Math.round(semitones) === 0 ? ', in the same key' : `, moved ${formatTranspose(semitones).toLowerCase()} to your key`;
}

// Stable ids per analysis object, used to restart the AI conversation when the take changes.
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
  const [savedFor, setSavedFor] = useState<string[]>([]);

  useEffect(() => setSavedFor([]), [analysis]);

  const tabScores = useMemo(() => {
    const out = new Map<string, number>();
    if (!analysis) return out;
    for (const p of profiles) {
      if (comparison && p.id === comparison.profileId) {
        out.set(p.id, comparison.overall);
        continue;
      }
      try {
        out.set(p.id, compareToProfile(analysis, p).overall);
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
  const items = [...plan.items].sort((a, b) => a.priority - b.priority);
  const moves = plan.signatureFocus
    .map((f) => ({ focus: f, move: profile.signatureMoves.find((m) => m.id === f.moveId) }))
    .filter((x) => x.move);
  const warnings = [...analysis.warnings, ...state.notices];
  const lowMidi = Math.min(40, (analysis.pitch.lowMidi ?? 40) - 2, profile.typicalRange.lowMidi - 2);
  const highMidi = Math.max(84, (analysis.pitch.highMidi ?? 84) + 2, profile.typicalRange.highMidi + 2);
  const saved = savedFor.includes(profile.id);
  const takeName = take?.name ?? 'Take';

  const onSave = () => {
    if (app.saveSession(takeName)) setSavedFor((s) => [...s, profile.id]);
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
    downloadBlob(new Blob([toJson(data)], { type: 'application/json' }), `${slugify(takeName)}-${profile.id}-analysis.json`);
  };
  const onDownloadWav = () => {
    if (!take) return;
    downloadBlob(new Blob([encodeWav(take.samples, take.sampleRate)], { type: 'audio/wav' }), `${slugify(takeName)}.wav`);
  };

  return (
    <div className="page page--results" style={style}>
      <nav className="singer-tabs" aria-label="Compare this take against">
        {profiles.map((p) => {
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
              {score !== undefined && <span className="singer-tab-score num">{Math.round(score)}</span>}
            </button>
          );
        })}
      </nav>

      <header className="results-head">
        <div className="results-dial">
          <ScoreDial score={comparison.overall} label={`Match with ${name}`} color={color} size={176} />
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
              <dt>Suggested key</dt>
              <dd>{formatTranspose(comparison.suggestedTransposeSemitones)}</dd>
            </div>
            <div>
              <dt>Tuning</dt>
              <dd className="num">{formatCents(analysis.pitch.tuningOffsetCents)}</dd>
            </div>
          </dl>
          <p className="range-note">{comparison.rangeNote}</p>
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
            Your coaching plan
          </h2>
          <p className="section-sub">What to work on to sound more like {name}, most important first.</p>
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

      <section className="results-section" aria-labelledby="style-heading">
        <div className="section-head">
          <h2 id="style-heading" className="section-title">
            Style match
          </h2>
          <p className="section-sub">
            Each measure against {possessive(name)} target band. Scores are closeness, not quality: a low score only means different from the
            target.
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

      <section className="results-section" aria-labelledby="pitch-heading">
        <div className="section-head">
          <h2 id="pitch-heading" className="section-title">
            Pitch and registers
          </h2>
          <p className="section-sub">
            Your pitch over time, coloured by estimated register. The shaded band is your passaggio (
            <span className="num">{noteRange(analysis.passaggio.lowMidi, analysis.passaggio.highMidi)}</span>).
            {refComp && reference ? ` The dashed line is ${reference.name}${keyShiftPhrase(refComp.transposeSemitones)}.` : ''}
          </p>
        </div>
        <PitchPlot
          analysis={analysis}
          reference={refComp && reference ? reference.analysis : undefined}
          referenceShiftSemitones={refComp?.transposeSemitones}
          referencePath={refComp?.path}
        />
        <p className="caveat">
          Registers are estimated from acoustic cues (the balance of the first two harmonics, spectral slope, brightness, and loudness
          against pitch). Vowels and the microphone shift those cues, so treat the colours as a guide, not a diagnosis.
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
            {moves.map(({ focus, move }) => (
              <article key={focus.moveId} className="move">
                <h3 className="move-name">{move!.name}</h3>
                <p>{move!.description}</p>
                <p className="move-hint">{focus.hint}</p>
                {move!.howTo.length > 0 && (
                  <ol className="move-steps">
                    {move!.howTo.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ol>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      {refComp && reference && (
        <section className="results-section" aria-labelledby="ref-heading">
          <div className="section-head">
            <h2 id="ref-heading" className="section-title">
              Against your reference clip
            </h2>
            <p className="section-sub">
              Your pitch lined up with <strong>{reference.name}</strong> phrase by phrase{keyShiftPhrase(refComp.transposeSemitones)}.
            </p>
          </div>
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
          {Object.keys(refComp.styleDiff).length > 0 && (
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
          conversationKey={`${analysisId(analysis)}|${profile.id}|${refComp ? analysisId(refComp) : 0}`}
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
        <button type="button" className="button button--accent" onClick={onSave} disabled={saved}>
          <Icon name="save" size={16} /> {saved ? 'Saved to Progress' : 'Save to progress'}
        </button>
        <button type="button" className="button button--ghost" onClick={onDownloadJson}>
          <Icon name="download" size={16} /> Download analysis (JSON)
        </button>
        <button type="button" className="button button--ghost" onClick={onDownloadWav} disabled={!take}>
          <Icon name="download" size={16} /> Download take (WAV)
        </button>
        <button type="button" className="button button--ghost" onClick={() => app.go('studio')}>
          <Icon name="mic" size={16} /> Record another take
        </button>
        <p className="muted results-actions-note" aria-live="polite">
          {saved ? 'Saved. See your trend on the Progress page.' : 'Saving keeps only the scores and measurements, not the audio.'}
        </p>
      </section>
    </div>
  );
}
