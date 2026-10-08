// Studio: pick the target singer, then record, upload or try the demo take. Optional reference
// clip calibrates the target from a recording the user owns.

import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MAX_ANALYSIS_SEC } from '../../analysis/analyze';
import { passaggioFor, VOICE_TYPE_LABELS, VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { createRecorder, MAX_RECORD_SEC, microphoneUnavailableReason, type InterruptionReason, type Recorder, type RecorderInfo } from '../../audio/recorder';
import { getExercise } from '../../coach/exercises';
import { isIos } from '../../pwa/platform';
import { useApp } from '../../state/context';
import { REFERENCE_ID } from '../../state/reducer';
import { TrainerContext } from '../../state/trainerContext';
import type { SingerProfile, VoiceType } from '../../types';
import { AnalysisProgress } from '../components/AnalysisProgress';
import { FileDrop } from '../components/FileDrop';
import { InstallCard } from '../components/InstallCard';
import { formatClock, noteRange } from '../components/format';
import { Icon } from '../components/Icon';
import { LiveMonitor } from '../components/LiveMonitor';
import { MeasurePanel } from '../components/MeasurePanel';
import { Notice } from '../components/Notice';
import { OpenInTrainer } from '../components/OpenInTrainer';
import { ReferenceCard, SingerCard } from '../components/SingerCard';
import { shortName, singerColor } from '../components/singer';

type RecPhase = 'idle' | 'starting' | 'recording' | 'stopping';

const UPLOAD_HINT = 'WAV, MP3, M4A, AAC, OGG, WebM or FLAC. Drag a file here or choose one.';
/** iPhone: where a Voice Memo has to be before the file picker can see it. */
const IOS_UPLOAD_HINT = 'WAV, MP3, M4A, AAC or FLAC from the Files app. For a Voice Memo: open it, tap ••• then Share, Save to Files, and choose it here.';

/** Plain-English reasons a take lost its microphone (iPhone suspends capture when the app is not in front). */
const INTERRUPTION_TEXT: Record<InterruptionReason, string> = {
  hidden: 'Mimic was sent to the background, and iPhone pauses the microphone when that happens. Stay in the app while you sing.',
  muted: 'The system muted the microphone (a call, Siri or another app using it).',
  ended: 'The microphone stopped delivering sound.',
  'context-stopped': 'iPhone paused the audio engine.',
  'no-audio': 'No sound has reached the app yet. Check that the microphone is not covered or in use by another app.',
};

const LOW_BANDWIDTH_TEXT =
  'This take was recorded through a Bluetooth microphone, which iOS runs in a low-quality phone-call mode (8-24 kHz). Breathiness and brightness read differently; use the iPhone’s own microphone (Settings) for takes you want to compare.';
const VOICE_TYPES = Object.keys(VOICE_TYPE_LABELS) as VoiceType[];

/** Smooth scrolling only when the user has not asked for reduced motion. */
function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  } catch {
    return 'auto';
  }
}

function measuredFooter(clips: number): ReactNode {
  return clips > 0 ? `Measured from ${clips} clip${clips === 1 ? '' : 's'}` : undefined;
}

function recordingName(): string {
  const when = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Recording ${when}`;
}

function SingerPanel(props: { profile: SingerProfile; baseName?: string; measure?: ReactNode }) {
  const { profile } = props;
  const style = { '--singer': singerColor(profile) } as CSSProperties;
  return (
    <section className="singer-panel" style={style} aria-labelledby="singer-panel-name">
      <p className="eyebrow">
        {profile.source === 'reference'
          ? 'Target from your reference clip'
          : profile.source === 'measured'
            ? 'Target sound, measured from your clips'
            : 'Target sound'}
      </p>
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
      {props.measure}
    </section>
  );
}

export function StudioPage() {
  const app = useApp();
  const trainer = useContext(TrainerContext);
  const { state, builtins, profile } = app;
  const busy = state.status !== 'idle';
  const micUnavailable = useMemo(() => microphoneUnavailableReason(), []);

  const recRef = useRef<Recorder | null>(null);
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [interruption, setInterruption] = useState<InterruptionReason | null>(null);
  const [micInfo, setMicInfo] = useState<RecorderInfo | null>(null);
  const [refOpen, setRefOpen] = useState(false);
  const [rejectMsg, setRejectMsg] = useState<string | null>(null);
  const [refRejectMsg, setRefRejectMsg] = useState<string | null>(null);
  // What the recording live region says; it stays mounted so screen readers pick up each change.
  const [recAnnounce, setRecAnnounce] = useState('');
  const refPanelRef = useRef<HTMLElement>(null);
  const captureRef = useRef<HTMLElement>(null);
  const recordRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const passaggio = passaggioFor(state.settings.voiceType);
  const voiceName = VOICE_TYPE_NAMES[state.settings.voiceType];
  const drill = state.drillExerciseId ? getExercise(state.drillExerciseId) : undefined;
  const referenceSelected = state.selectedProfileId === REFERENCE_ID;
  const errorAt = state.error ? (state.errorJob ?? 'page') : null;
  const showReferencePanel = refOpen || referenceSelected || !!state.reference || errorAt === 'reference';

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
  const focusRecord = () => requestAnimationFrame(() => recordRef.current?.focus());

  // Keyboard focus follows the control that replaced the one just pressed: Record becomes Stop.
  useEffect(() => {
    if (phase === 'recording') stopRef.current?.focus();
  }, [phase]);

  // Show a failure where it happened: next to the upload, in the reference panel, or at the top.
  useEffect(() => {
    if (state.error) errorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });
  }, [state.error]);

  // Arriving from "Record this drill": bring the capture controls into view with focus on Record
  // (or on the upload when the microphone is unavailable). Deferred past the page-change focus.
  const drillFocusPending = useRef(!!state.drillExerciseId);
  useEffect(() => {
    if (!drillFocusPending.current) return;
    // The flag clears only once the frame runs, so a cancelled first run (StrictMode) retries.
    const id = requestAnimationFrame(() => {
      drillFocusPending.current = false;
      captureRef.current?.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
      const target = recordRef.current && !recordRef.current.disabled ? recordRef.current : captureRef.current?.querySelector<HTMLInputElement>('input[type="file"]');
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const stopRecording = async () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    setPhase('stopping');
    setRecAnnounce('Recording stopped. Analysing your take.');
    setAnalyser(null);
    const lowBandwidth = r.info?.lowBandwidth ?? false;
    const { samples, sampleRate, interrupted } = await r.stop();
    setPhase('idle');
    setInterruption(null);
    setMicInfo(null);
    // Tell the Results page what the take went through, so a gap or a phone-call-quality microphone is not a mystery.
    const notices = [
      ...(interrupted ? [`This take was interrupted: ${INTERRUPTION_TEXT[interrupted]} Only the audio that arrived was analysed.`] : []),
      ...(lowBandwidth ? [LOW_BANDWIDTH_TEXT] : []),
    ];
    const ok = await app.analyzeSamples({ samples, sampleRate, source: 'recording', name: recordingName(), ...(notices.length ? { notices } : {}) });
    if (!ok && mountedRef.current) {
      setRecAnnounce('');
      focusRecord();
    }
    showResults(ok);
  };

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => {
      // Seconds of audio actually received: iOS keeps wall time running while it suspends the microphone.
      const captured = recRef.current?.capturedSec;
      const sec = typeof captured === 'number' && Number.isFinite(captured) ? captured : (performance.now() - startedAt) / 1000;
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
    r.onInterruption = (reason) => {
      if (recRef.current === r) setInterruption(reason);
    };
    recRef.current = r;
    setInterruption(null);
    setPhase('starting');
    setRecAnnounce('Waiting for the microphone.');
    try {
      await r.start();
    } catch (err) {
      recRef.current = null;
      setPhase('idle');
      setRecAnnounce('');
      setMicError(err instanceof Error ? err.message : 'The microphone could not be started.');
      focusRecord();
      return;
    }
    if (recRef.current !== r) {
      r.cancel();
      return;
    }
    setAnalyser(r.analyser);
    setMicInfo(r.info ?? null);
    setStartedAt(performance.now());
    setElapsed(0);
    setPhase('recording');
    setRecAnnounce('Recording started. Choose Stop and analyse when you have finished.');
  };

  const cancelRecording = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setAnalyser(null);
    setInterruption(null);
    setMicInfo(null);
    setPhase('idle');
    setRecAnnounce('Recording discarded.');
    focusRecord();
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

  const onReferenceFile = (file: File) => {
    setRefRejectMsg(null);
    void app.loadReferenceFile(file);
  };

  const onReferenceCard = () => {
    // A clip that can't be used is never selected; the panel explains why.
    if (state.reference?.usable) app.selectProfile(REFERENCE_ID);
    setRefOpen(true);
    requestAnimationFrame(() => refPanelRef.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' }));
  };

  const errorNotice = (where: 'take' | 'reference' | 'page'): ReactNode =>
    errorAt === where && (
      <div ref={errorRef} className="error-anchor">
        <Notice tone="error" onDismiss={() => app.dispatch({ type: 'error/clear' })}>
          <p>{state.error}</p>
        </Notice>
      </div>
    );

  const recording = phase === 'recording';
  const takeJob = busy && state.job === 'take';
  const refJob = busy && state.job === 'reference';
  const baseName = state.reference?.baseProfileId ? builtins.find((b) => b.id === state.reference?.baseProfileId)?.name : undefined;
  const targetName = profile ? shortName(profile) : 'your target';
  const clipNotes = state.reference ? [...state.reference.notices, ...state.reference.analysis.warnings] : [];

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

      <InstallCard />

      {drill && (
        <Notice tone="info" title={`Recording a drill: ${drill.name}`} onDismiss={() => app.dispatch({ type: 'drill/set', exerciseId: null })}>
          <p>{drill.goal} Record or upload it below and the take will be labelled with the drill name.</p>
        </Notice>
      )}

      {errorNotice('page')}
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
            <SingerCard
              key={p.id}
              profile={p}
              selected={state.selectedProfileId === p.id}
              onSelect={() => app.selectProfile(p.id)}
              footer={measuredFooter(state.measurements[p.id]?.length ?? 0)}
            />
          ))}
          <ReferenceCard
            loadedName={state.reference?.name ?? null}
            unusable={!!state.reference && !state.reference.usable}
            selected={referenceSelected}
            onSelect={onReferenceCard}
          />
        </div>
      </section>

      <div className="studio-grid">
        <section ref={captureRef} className="capture" aria-labelledby="capture-heading">
          <h2 id="capture-heading" className="section-title">
            Capture a take
          </h2>

          <div className={`record-block${recording ? ' record-block--live' : ''}`}>
            <p className="visually-hidden" role="status">
              {recAnnounce}
            </p>
            {recording || phase === 'stopping' ? (
              <>
                <div className="record-status">
                  <span className="rec-light" aria-hidden="true" />
                  <span className="rec-label">Recording</span>
                  <span className="num rec-time" role="timer" aria-label={`Elapsed ${formatClock(elapsed)}`}>
                    {formatClock(elapsed)}
                    <span className="muted"> / {formatClock(MAX_RECORD_SEC)}</span>
                  </span>
                </div>
                {micInfo && (micInfo.inputLabel || micInfo.inputSampleRate) && (
                  <p className="record-help num">
                    {[micInfo.inputLabel, micInfo.inputSampleRate ? `${(micInfo.inputSampleRate / 1000).toFixed(micInfo.inputSampleRate % 1000 ? 1 : 0)} kHz` : null].filter(Boolean).join(' · ')}
                  </p>
                )}
                {interruption && (
                  <Notice tone="warn" title="The recording was interrupted">
                    <p>{INTERRUPTION_TEXT[interruption]}</p>
                    <p>The take has a gap or ends there. Choose Stop and analyse to use what was captured, or Discard and record again.</p>
                  </Notice>
                )}
                {micInfo?.lowBandwidth && (
                  <Notice tone="warn" title="Bluetooth microphone in use">
                    <p>{LOW_BANDWIDTH_TEXT}</p>
                  </Notice>
                )}
                {analyser && <LiveMonitor analyser={analyser} a4Hz={state.settings.a4Hz} centreMidi={(passaggio.lowMidi + passaggio.highMidi) / 2} />}
                <div className="record-actions">
                  <button ref={stopRef} type="button" className="button button--rec" onClick={() => void stopRecording()} disabled={phase === 'stopping'}>
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
                  ref={recordRef}
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
                  {drill && ` This take will be labelled with the drill “${drill.name}”.`}
                </p>
              </>
            )}
          </div>

          {(micUnavailable || micError) && (
            <Notice tone={micError ? 'error' : 'warn'} title={micError ? 'The microphone did not start' : 'Recording is not available here'}>
              <p>{micError ?? micUnavailable}</p>
              {micError && isIos() && (
                <p>
                  On iPhone, check the microphone setting for this site (Safari: the aA button, then Website Settings; or Settings, then Safari, then
                  Microphone). If it already says Allow, close Mimic completely in the app switcher and open it again: after iOS restarts its audio
                  service, the microphone can stay blocked until the app is relaunched.
                </p>
              )}
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
            hint={isIos() ? IOS_UPLOAD_HINT : UPLOAD_HINT}
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

          {errorNotice('take')}
          <AnalysisProgress status={takeJob ? state.status : 'idle'} progress={state.progress} label={state.progressLabel} />

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
                <span className="num">{noteRange(passaggio.lowMidi, passaggio.highMidi)}</span> for a {voiceName.toLowerCase()}), so there is mix to
                measure. Change voice type in Settings.
              </li>
              <li>Warm up first, and sing at a comfortable volume. Never push to reach a note.</li>
            </ul>
          </details>
        </section>

        <div className="studio-side">
          {profile ? (
            <SingerPanel
              profile={profile}
              baseName={profile.source === 'reference' ? baseName : undefined}
              measure={
                profile.source === 'reference' ? undefined : (
                  <MeasurePanel
                    key={profile.id}
                    singerId={profile.id}
                    trainer={trainer}
                    singerName={profile.name}
                    clips={state.measurements[profile.id] ?? []}
                    onMeasure={(files, onProgress) => app.measureClips(profile.id, files, onProgress)}
                    onRemove={(clipId) => app.removeMeasuredClip(profile.id, clipId)}
                    onClear={() => app.clearMeasuredClips(profile.id)}
                  />
                )
              }
            />
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
              {!state.reference.usable ? (
                <Notice tone="warn" title="This clip can’t be used as a target">
                  <p>{state.reference.unusableReason}</p>
                </Notice>
              ) : (
                clipNotes.length > 0 && (
                  <div className="reference-notes">
                    <p className="subhead">About this clip</p>
                    <ul className="plain-list">
                      {clipNotes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )
              )}
              <div className="button-row">
                {state.reference.usable && !referenceSelected && (
                  <button type="button" className="button button--accent button--small" onClick={() => app.selectProfile(REFERENCE_ID)}>
                    Use as target
                  </button>
                )}
                <OpenInTrainer name={state.reference.name} samples={state.reference.samples} sampleRate={state.reference.sampleRate} addLabel="Open in Trainer" />
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
              <option value="">Not sure (analyse as {voiceName.toLowerCase()}, like my voice)</option>
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
            hint={`An isolated vocal or an a cappella section, up to ${MAX_ANALYSIS_SEC / 60} minutes`}
            disabled={busy || recording}
            onFile={onReferenceFile}
            onReject={setRefRejectMsg}
          />
          {refRejectMsg && (
            <p className="field-error" role="alert">
              {refRejectMsg}
            </p>
          )}
          {errorNotice('reference')}
          <AnalysisProgress status={refJob ? state.status : 'idle'} progress={state.progress} label={state.progressLabel} />
        </section>
      )}
    </div>
  );
}
