// Studio: pick the target singer, then record, upload or try the demo take. Optional reference
// clip calibrates the target from a recording the user owns.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { passaggioFor, VOICE_TYPE_LABELS } from '../../analysis/passaggio';
import { createRecorder, MAX_RECORD_SEC, microphoneUnavailableReason, type Recorder } from '../../audio/recorder';
import { getExercise } from '../../coach/exercises';
import { useApp } from '../../state/context';
import { REFERENCE_ID } from '../../state/reducer';
import type { SingerProfile, VoiceType } from '../../types';
import { AnalysisProgress } from '../components/AnalysisProgress';
import { FileDrop } from '../components/FileDrop';
import { formatClock, noteRange } from '../components/format';
import { Icon } from '../components/Icon';
import { LiveMonitor } from '../components/LiveMonitor';
import { Notice } from '../components/Notice';
import { ReferenceCard, SingerCard } from '../components/SingerCard';
import { shortName, singerColor } from '../components/singer';

type RecPhase = 'idle' | 'starting' | 'recording' | 'stopping';

const UPLOAD_HINT = 'WAV, MP3, M4A, AAC, OGG, WebM or FLAC. Drag a file here or choose one.';
const VOICE_TYPES = Object.keys(VOICE_TYPE_LABELS) as VoiceType[];

function recordingName(): string {
  const when = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Recording ${when}`;
}

function SingerPanel(props: { profile: SingerProfile; baseName?: string }) {
  const { profile } = props;
  const style = { '--singer': singerColor(profile) } as CSSProperties;
  return (
    <section className="singer-panel" style={style} aria-labelledby="singer-panel-name">
      <p className="eyebrow">{profile.source === 'reference' ? 'Target from your reference clip' : 'Target sound'}</p>
      <h2 id="singer-panel-name" className="singer-panel-name">
        {profile.name}
      </h2>
      <p className="singer-panel-desc">{profile.description}</p>
      {profile.traits.length > 0 && (
        <ul className="trait-list">
          {profile.traits.slice(0, 3).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <p className="singer-panel-range">
        <span className="muted">Typical range</span>{' '}
        <span className="num">{noteRange(profile.typicalRange.lowMidi, profile.typicalRange.highMidi)}</span>
        <span className="muted"> · sits around </span>
        <span className="num">{noteRange(profile.typicalRange.tessituraLowMidi, profile.typicalRange.tessituraHighMidi)}</span>
      </p>
      {profile.studySongs.length > 0 && (
        <>
          <h3 className="subhead">Songs to study</h3>
          <ul className="song-list">
            {profile.studySongs.map((s) => (
              <li key={s.title}>
                <span className="song-title">{s.title}</span>
                <span className="song-listen">{s.listenFor}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="source-note">
        {props.baseName ? `Weights, songs and signature moves come from the ${props.baseName} profile. ` : ''}
        {profile.sourceNote}
      </p>
    </section>
  );
}

export function StudioPage() {
  const app = useApp();
  const { state, builtins, profile } = app;
  const busy = state.status !== 'idle';
  const micUnavailable = useMemo(() => microphoneUnavailableReason(), []);

  const recRef = useRef<Recorder | null>(null);
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [refOpen, setRefOpen] = useState(false);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const refPanelRef = useRef<HTMLElement>(null);

  const passaggio = passaggioFor(state.settings.voiceType);
  const voiceLabel = VOICE_TYPE_LABELS[state.settings.voiceType];
  const drill = state.drillExerciseId ? getExercise(state.drillExerciseId) : undefined;
  const referenceSelected = state.selectedProfileId === REFERENCE_ID;
  const showReferencePanel = refOpen || referenceSelected || !!state.reference;

  // Stop the microphone if the user navigates away mid-take, and do not jump to Results from a
  // page the user has already left.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recRef.current?.cancel();
    };
  }, []);
  const showResults = (ok: boolean) => {
    if (ok && mountedRef.current) app.go('results');
  };

  const stopRecording = async () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    setPhase('stopping');
    setAnalyser(null);
    const { samples, sampleRate } = await r.stop();
    setPhase('idle');
    showResults(await app.analyzeSamples({ samples, sampleRate, source: 'recording', name: recordingName() }));
  };

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      const sec = (performance.now() - startedAt) / 1000;
      setElapsed(sec);
      if (sec >= MAX_RECORD_SEC) void stopRecording();
    }, 250);
    return () => clearInterval(id);
    // stopRecording only reads refs and stable controller methods, so it is not a dependency.
  }, [phase, startedAt]);

  const startRecording = async () => {
    if (phase !== 'idle' || busy) return;
    setMicError(null);
    setRejectMsg(null);
    app.dispatch({ type: 'error/clear' });
    const r = createRecorder();
    recRef.current = r;
    setPhase('starting');
    try {
      await r.start();
    } catch (err) {
      recRef.current = null;
      setPhase('idle');
      setMicError(err instanceof Error ? err.message : 'The microphone could not be started.');
      return;
    }
    if (recRef.current !== r) {
      r.cancel();
      return;
    }
    setAnalyser(r.analyser);
    setStartedAt(performance.now());
    setElapsed(0);
    setPhase('recording');
  };

  const cancelRecording = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setAnalyser(null);
    setPhase('idle');
  };

  const onUpload = async (file: File) => {
    setRejectMsg(null);
    setMicError(null);
    showResults(await app.analyzeFile(file));
  };

  const onDemo = async () => {
    setRejectMsg(null);
    showResults(await app.analyzeDemo());
  };

  const onReferenceCard = () => {
    if (state.reference) app.selectProfile(REFERENCE_ID);
    setRefOpen(true);
    requestAnimationFrame(() => refPanelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
  };

  const recording = phase === 'recording';
  const takeJob = busy && state.job === 'take';
  const refJob = busy && state.job === 'reference';
  const baseName = state.reference?.baseProfileId ? builtins.find((b) => b.id === state.reference?.baseProfileId)?.name : undefined;
  const targetName = profile ? shortName(profile) : 'your target';

  return (
    <div className="page page--studio">
      <header className="page-head">
        <p className="eyebrow">Studio</p>
        <h1 className="page-title">Sing a take, hear how close you are</h1>
        <p className="lede">
          Pick a target sound, record or upload a phrase, and get a coaching plan for your mix, tone and phrasing. Everything is analysed
          on this device.
        </p>
      </header>

      {drill && (
        <Notice tone="info" title={`Recording a drill: ${drill.name}`} onDismiss={() => app.dispatch({ type: 'drill/set', exerciseId: null })}>
          <p>{drill.goal} Record it below and the take will be labelled with the drill name.</p>
        </Notice>
      )}

      {state.error && (
        <Notice tone="error" onDismiss={() => app.dispatch({ type: 'error/clear' })}>
          <p>{state.error}</p>
        </Notice>
      )}
      {state.notices.map((n) => (
        <Notice key={n} tone="warn">
          <p>{n}</p>
        </Notice>
      ))}

      <section className="studio-pick" aria-labelledby="pick-heading">
        <h2 id="pick-heading" className="section-title">
          Who do you want to sound like?
        </h2>
        <div className="singer-grid">
          {builtins.map((p) => (
            <SingerCard key={p.id} profile={p} selected={state.selectedProfileId === p.id} onSelect={() => app.selectProfile(p.id)} />
          ))}
          <ReferenceCard loadedName={state.reference?.name ?? null} selected={referenceSelected} onSelect={onReferenceCard} />
        </div>
      </section>

      <div className="studio-grid">
        <section className="capture" aria-labelledby="capture-heading">
          <h2 id="capture-heading" className="section-title">
            Capture a take
          </h2>

          <div className={`record-block${recording ? ' record-block--live' : ''}`}>
            {recording || phase === 'stopping' ? (
              <>
                <div className="record-status">
                  <span className="rec-light" aria-hidden="true" />
                  <span className="rec-label">Recording</span>
                  <span className="num rec-time" aria-label={`Elapsed ${formatClock(elapsed)}`}>
                    {formatClock(elapsed)}
                    <span className="muted"> / {formatClock(MAX_RECORD_SEC)}</span>
                  </span>
                </div>
                {analyser && <LiveMonitor analyser={analyser} a4Hz={state.settings.a4Hz} centreMidi={(passaggio.lowMidi + passaggio.highMidi) / 2} />}
                <div className="record-actions">
                  <button type="button" className="button button--rec" onClick={() => void stopRecording()} disabled={phase === 'stopping'}>
                    <Icon name="stop" size={16} /> Stop and analyse
                  </button>
                  <button type="button" className="button button--ghost" onClick={cancelRecording} disabled={phase === 'stopping'}>
                    Discard
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="record-button"
                  onClick={() => void startRecording()}
                  disabled={busy || phase !== 'idle' || !!micUnavailable}
                  aria-describedby="record-help"
                >
                  <span className="record-button-dot" aria-hidden="true" />
                  <span>{phase === 'starting' ? 'Waiting for the microphone…' : 'Record'}</span>
                </button>
                <p id="record-help" className="record-help">
                  Sing one phrase or a verse, up to {MAX_RECORD_SEC / 60} minutes. You’ll see your note and level live.
                </p>
              </>
            )}
          </div>

          {(micUnavailable || micError) && (
            <Notice tone={micError ? 'error' : 'warn'} title={micError ? 'The microphone did not start' : 'Recording is not available here'}>
              <p>{micError ?? micUnavailable}</p>
              <p>
                You can still get coached: record a voice memo on your phone, then upload it below. Or try the demo take to see how the results
                look.
              </p>
            </Notice>
          )}

          <div className="capture-or" aria-hidden="true">
            <span>or</span>
          </div>

          <FileDrop
            label="Upload a recording"
            hint={UPLOAD_HINT}
            disabled={busy || recording}
            onFile={(f) => void onUpload(f)}
            onReject={setRejectMsg}
          />
          {rejectMsg && (
            <p className="field-error" role="alert">
              {rejectMsg}
            </p>
          )}

          <div className="demo-row">
            <button type="button" className="button button--ghost" onClick={() => void onDemo()} disabled={busy || recording}>
              <Icon name="play" size={14} /> Try a demo take
            </button>
            <span className="muted demo-note">A synthesised 15-second phrase, so you can see the results without singing.</span>
          </div>

          {takeJob && <AnalysisProgress status={state.status} progress={state.progress} label={state.progressLabel} />}

          {state.analysis && state.take && !busy && (
            <p className="last-result">
              <span className="muted">Last take:</span> {state.take.name}{' '}
              <button type="button" className="link-button" onClick={() => app.go('results')}>
                View results
              </button>
            </p>
          )}

          <details className="tips" open>
            <summary>Tips for a good take</summary>
            <ul>
              <li>Find a quiet room with soft furnishings; turn off fans and music.</li>
              <li>
                Hold the phone or mic <strong>20–30 cm</strong> from your mouth and keep that distance.
              </li>
              <li>
                Sing <strong>15–60 seconds</strong>: one phrase or a verse, without backing music.
              </li>
              <li>
                Choose a phrase that crosses your passaggio (about{' '}
                <span className="num">{noteRange(passaggio.lowMidi, passaggio.highMidi)}</span> for a {voiceLabel.toLowerCase()}), so there is mix to
                measure. Change voice type in Settings.
              </li>
              <li>Warm up first, and sing at a comfortable volume. Never push to reach a note.</li>
            </ul>
          </details>
        </section>

        <div className="studio-side">
          {profile ? (
            <SingerPanel profile={profile} baseName={profile.source === 'reference' ? baseName : undefined} />
          ) : (
            <p className="muted">Choose a singer to see their sound.</p>
          )}
        </div>
      </div>

      {showReferencePanel && (
        <section ref={refPanelRef} className="reference-panel" aria-labelledby="ref-heading">
          <h2 id="ref-heading" className="section-title">
            Reference clip <span className="muted section-title-note">(optional)</span>
          </h2>
          <p className="reference-intro">
            Upload a clip of the artist from music you own. Mimic measures it the same way it measures you, then targets those numbers
            instead of the hand-set estimates and compares your take phrase by phrase. An isolated vocal or an a cappella section works best;
            backing tracks make the measurements less reliable. The clip never leaves this device.
          </p>
          {state.reference ? (
            <div className="reference-loaded">
              <p>
                <span className="muted">Loaded:</span> <strong>{state.reference.name}</strong>{' '}
                <span className="num muted">({Math.round(state.reference.analysis.durationSec)} s)</span>
              </p>
              <div className="button-row">
                {!referenceSelected && (
                  <button type="button" className="button button--accent button--small" onClick={() => app.selectProfile(REFERENCE_ID)}>
                    Use as target
                  </button>
                )}
                <button type="button" className="button button--ghost button--small" onClick={() => app.clearReference()} disabled={busy}>
                  Remove reference
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">
              New reference profiles borrow weights, songs and signature moves from the singer selected now ({targetName}).
            </p>
          )}
          <div className="field">
            <label htmlFor="ref-voice" className="field-label">
              Analyse the reference as
            </label>
            <select
              id="ref-voice"
              className="select"
              value={state.referenceVoiceType ?? ''}
              onChange={(e) => app.setReferenceVoiceType((e.currentTarget.value || null) as VoiceType | null)}
              disabled={busy}
            >
              <option value="">Same as my voice type ({voiceLabel})</option>
              {VOICE_TYPES.map((v) => (
                <option key={v} value={v}>
                  {VOICE_TYPE_LABELS[v]}
                </option>
              ))}
            </select>
            <p className="field-hint">Sets the passaggio used to judge the artist’s register shares. Pick the artist’s approximate voice type if it differs from yours.</p>
          </div>
          <FileDrop
            compact
            label={state.reference ? 'Replace the reference clip' : 'Upload a reference clip'}
            hint="A song excerpt or stem, up to 6 minutes"
            disabled={busy || recording}
            onFile={(f) => void app.loadReferenceFile(f)}
            onReject={setRejectMsg}
          />
          {refJob && <AnalysisProgress status={state.status} progress={state.progress} label={state.progressLabel} />}
        </section>
      )}
    </div>
  );
}
