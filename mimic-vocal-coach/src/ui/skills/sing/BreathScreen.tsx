// Breath control: (a) paced breathing with an animated guide (no microphone): in 4 low and wide, a gentle suspend
// of 4, out on a steady "sss" for 8, the exhale growing by 2 counts a round up to the cap; (b) the hiss test: one
// breath, a steady "sss" for as long as is comfortable (duration and steadiness); (c) a long tone on a comfortable
// middle note (duration, pitch and loudness steadiness). Personal bests, and the safety notes always visible.

import { useEffect, useMemo, useRef, useState } from 'react';
import { isDesktopKind } from '../../../pwa/platform';
import { AUTO_STOP_RULES } from '../../../skills/audio';
import { foldCents } from '../../../skills/score';
import { BREATH_DEFAULTS, noteEvents, pacedBreathPlan } from '../../../skills/theory';
import type { BreathPlan, BreathSession, HissScore, LongToneScore, PacedBreathRound, SkillsBests, SkillScreenProps } from '../../../skills/types';
import { a4For, toleranceFor, hissSteadinessLabel, NO_PITCH_TEXT, noteName, pitchSteadinessLabel, rangeFor, seconds, sessionBase, TOO_QUIET_TEXT, centsCount } from './common';
import { useSingDeps, type SingDeps } from './deps';
import { outcomeError, useSkillKeys, useTake } from './useTake';
import { ErrorNotice, FindingList, LevelBar, LiveRegion, PitchNeedle, SafetyNote, ScreenHead, Stat, TakeStatus, useAnnounceFocus } from './widgets';

export type BreathScreenProps = SkillScreenProps<BreathSession> & { plan?: BreathPlan; bests?: SkillsBests; deps?: Partial<SingDeps> };

type Part = BreathPlan['parts'][number];
const PART_LABELS: Record<Part, string> = { paced: 'Paced breathing', hiss: 'Hiss test', 'long-tone': 'Long tone' };

/** A comfortable middle note: 40% of the way up the comfortable range. */
export function longToneMidi(low: number, high: number): number {
  return Math.round(low + (high - low) * 0.4);
}

// ---------------------------------------------------------------------------------------------
// Paced breathing guide

type BreathPhase = 'inhale' | 'suspend' | 'exhale' | 'rest';
const PHASE_WORDS: Record<BreathPhase, string> = {
  inhale: 'Breathe in, low and wide',
  suspend: 'Suspend: a gentle pause, throat open',
  exhale: 'Out on a steady "sss"',
  rest: 'Breathe normally',
};
/** Short phase word inside the circle, so the phase reads at a glance even without the growing circle (reduced motion). */
const PHASE_SHORT: Record<BreathPhase, string> = { inhale: 'In', suspend: 'Pause', exhale: 'Out', rest: 'Rest' };
/** Normal breathing between rounds: about two easy breaths, not one. */
const REST_COUNTS = 8;

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * The animated guide. Counts are one second each; between rounds there are 8 counts of normal breathing. It scrolls
 * itself into view when it starts (Return on a Mac starts it with the page scrolled up), and Escape, Return or Space
 * stop it.
 */
export function BreathGuide(props: { plan: readonly PacedBreathRound[]; onFinish(done: { rounds: number; maxExhaleCounts: number }): void; onStop(done: { rounds: number; maxExhaleCounts: number }): void; countSec?: number }) {
  const countMs = Math.round((props.countSec ?? BREATH_DEFAULTS.countSec) * 1000);
  const [pos, setPos] = useState<{ round: number; phase: BreathPhase; count: number }>({ round: 0, phase: 'inhale', count: 1 });
  const reduced = useMemo(prefersReducedMotion, []);
  const finishRef = useRef(props.onFinish);
  finishRef.current = props.onFinish;
  const rootRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    try {
      rootRef.current?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    } catch {
      // Some embedded browsers do not scroll.
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const onControl = !!el && (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable);
      const isStopKey = e.key === 'Escape' || (!onControl && (e.key === 'Enter' || e.key === ' ' || e.code === 'Space'));
      if (!isStopKey) return;
      e.preventDefault();
      stopRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [reduced]);
  const round = props.plan[pos.round];
  const lengthOf = (phase: BreathPhase, r: PacedBreathRound) => (phase === 'rest' ? REST_COUNTS : r[phase]);

  useEffect(() => {
    const p = pos;
    const r = props.plan[p.round];
    if (!r) return;
    const id = setTimeout(() => {
      if (p.count < lengthOf(p.phase, r)) return setPos({ ...p, count: p.count + 1 });
      if (p.phase === 'exhale' && p.round + 1 >= props.plan.length) {
        setPos({ round: props.plan.length, phase: 'rest', count: 0 });
        finishRef.current({ rounds: p.round + 1, maxExhaleCounts: Math.max(...props.plan.slice(0, p.round + 1).map((x) => x.exhale)) });
        return;
      }
      if (p.phase === 'rest') return setPos({ round: p.round + 1, phase: 'inhale', count: 1 });
      const order: BreathPhase[] = ['inhale', 'suspend', 'exhale', 'rest'];
      setPos({ ...p, phase: order[order.indexOf(p.phase) + 1], count: 1 });
    }, countMs);
    return () => clearTimeout(id);
  }, [pos, countMs, props.plan]);

  if (!round) return null;
  const total = lengthOf(pos.phase, round);
  const scale = pos.phase === 'inhale' ? 0.45 + 0.55 * (pos.count / total) : pos.phase === 'suspend' ? 1 : pos.phase === 'exhale' ? 1 - 0.55 * (pos.count / total) : 0.45;
  const doneSoFar = { rounds: pos.round, maxExhaleCounts: pos.round > 0 ? Math.max(...props.plan.slice(0, pos.round).map((x) => x.exhale)) : 0 };
  stopRef.current = () => props.onStop(doneSoFar);
  return (
    <div ref={rootRef} className={`sing-breath sing-breath--${pos.phase}${reduced ? ' sing-breath--still' : ''}`}>
      <p className="sing-progress">
        Round {pos.round + 1} of {props.plan.length} · in {round.inhale}, suspend {round.suspend}, out {round.exhale}
      </p>
      <div className="sing-breath-stage" aria-hidden="true">
        <span className="sing-breath-circle" style={reduced ? undefined : { transform: `scale(${scale.toFixed(3)})`, transitionDuration: `${countMs}ms` }} />
        <span className="sing-breath-count">
          <span className="sing-breath-phase">{PHASE_SHORT[pos.phase]}</span>
          {pos.count}
        </span>
      </div>
      <p className="sing-breath-words" aria-live="polite">
        {PHASE_WORDS[pos.phase]}
        {pos.phase !== 'rest' ? ` (${total})` : ''}
      </p>
      <div className="sing-hold" aria-hidden="true">
        <span className="sing-hold-fill" style={{ width: `${Math.round((pos.count / total) * 100)}%` }} />
      </div>
      <div className="button-row">
        <button type="button" className="button" onClick={() => props.onStop(doneSoFar)}>
          Stop (Esc)
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function Trace(props: { values: readonly number[]; label: string }) {
  const v = props.values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return null;
  const W = 300;
  const H = 60;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = Math.max(1e-6, hi - lo);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - 4 - ((x - lo) / span) * (H - 8)).toFixed(1)}`).join(' ');
  return (
    <svg className="sing-mini-trace" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={props.label}>
      <polyline points={pts} fill="none" className="sing-trace-pitch" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BreathScreen(props: BreathScreenProps) {
  const deps = useSingDeps(props.deps);
  const take = useTake(deps);
  const kind = deps.platform();
  const desktop = isDesktopKind(kind);
  const a4Hz = a4For(props);
  const { voiceType } = props.settings;
  const { rangeOverride } = props.prefs;
  const range = useMemo(() => rangeFor(voiceType, rangeOverride), [voiceType, rangeOverride]);
  const toneMidi = longToneMidi(range.lowMidi, range.highMidi);
  const parts: Part[] = props.plan?.parts && props.plan.parts.length > 0 ? props.plan.parts : ['paced', 'hiss', 'long-tone'];
  const [part, setPart] = useState<Part>(parts[0]);
  const bests = useMemo(() => props.bests ?? deps.loadBests(), [props.bests, deps]);
  const pacedPlan = useMemo(() => pacedBreathPlan({ rounds: props.plan?.pacedRounds ?? BREATH_DEFAULTS.rounds }), [props.plan?.pacedRounds]);
  const [pacedRunning, setPacedRunning] = useState(false);
  const [paced, setPaced] = useState<BreathSession['paced']>(null);
  const [hiss, setHiss] = useState<HissScore | null>(null);
  const [tone, setTone] = useState<LongToneScore | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [finished, setFinished] = useState(false);
  const startedMs = useRef(deps.nowMs());
  const reported = useRef(false);
  const headingRef = useAnnounceFocus(part === 'hiss' ? hiss : part === 'long-tone' ? tone : paced);
  const busy = take.phase !== 'idle' || pacedRunning;

  const sessionOf = (p: BreathSession['paced'], h: HissScore | null, t: LongToneScore | null): BreathSession => ({
    ...sessionBase(props, deps, startedMs.current),
    kind: 'breath',
    paced: p,
    hiss: h ? { status: h.status, durationSec: h.durationSec, steadinessDb: h.steadinessDb } : null,
    longTone: t ? { status: t.status, durationSec: t.durationSec, midi: t.midi, pitchSdCents: t.pitchSdCents, loudnessSdDb: t.loudnessSdDb } : null,
  });
  const report = (p: BreathSession['paced'], h: HissScore | null, t: LongToneScore | null) => {
    if (reported.current) return;
    const any = (p && p.rounds > 0) || h?.status === 'ok' || t?.status === 'ok';
    if (!any) return;
    reported.current = true;
    props.onDone(sessionOf(p, h, t));
  };

  const runHiss = async () => {
    if (busy) return;
    setError(null);
    setHiss(null);
    const out = await take.run({ events: [], rule: AUTO_STOP_RULES.hiss(), a4Hz, score: (t) => deps.scoreHiss(t.samples, t.sampleRate) });
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    setHiss(out.value);
    setAnnounce(out.value.status === 'ok' ? `Hiss: ${seconds(out.value.durationSec)}, ${hissSteadinessLabel(out.value.steadinessDb)}.` : 'Hiss not scored.');
  };

  const runTone = async () => {
    if (busy) return;
    setError(null);
    setTone(null);
    const out = await take.run({ events: noteEvents(toneMidi), rule: AUTO_STOP_RULES.longTone(), a4Hz, score: (t) => deps.scoreLongTone(t.samples, t.sampleRate, { a4Hz }) });
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    setTone(out.value);
    setAnnounce(out.value.status === 'ok' ? `Long tone: ${seconds(out.value.durationSec)}, pitch ${pitchSteadinessLabel(out.value.pitchSdCents)}.` : 'Long tone not scored.');
  };

  const pacedDone = (d: { rounds: number; maxExhaleCounts: number }) => {
    setPacedRunning(false);
    const v = d.rounds > 0 ? d : null;
    setPaced(v);
    setAnnounce(d.rounds > 0 ? `Paced breathing: ${d.rounds} ${d.rounds === 1 ? 'round' : 'rounds'}, longest exhale ${d.maxExhaleCounts} counts.` : 'Paced breathing stopped.');
  };

  const partIndex = parts.indexOf(part);
  const nextPart = parts[partIndex + 1] ?? null;
  const done = () => {
    take.cancel();
    setFinished(true);
    report(paced, hiss, tone);
  };
  const exit = () => {
    take.cancel();
    report(paced, hiss, tone);
    props.onExit();
  };

  const latest = useRef({ paced, hiss, tone, report });
  latest.current = { paced, hiss, tone, report };
  useEffect(() => () => latest.current.report(latest.current.paced, latest.current.hiss, latest.current.tone), []);

  // After a finished set of rounds, Return moves on (Next or Done) instead of restarting a 40-second guide.
  const pacedSetDone = part === 'paced' && paced !== null;
  const moveOn = () => (props.plan && nextPart ? setPart(nextPart) : done());
  useSkillKeys(
    {
      // While the guide runs it owns the keys (Escape, Return and Space stop it).
      onReturn: pacedRunning
        ? undefined
        : () => {
            if (take.phase === 'listening') take.stop('key');
            else if (busy || finished) return;
            else if (part === 'hiss') void runHiss();
            else if (part === 'long-tone') void runTone();
            else if (pacedSetDone) moveOn();
            else if (part === 'paced') setPacedRunning(true);
          },
      onSpace: pacedRunning
        ? undefined
        : () => {
            if (take.phase === 'listening') take.stop('key');
            else if (part === 'long-tone' && !busy) void take.play(noteEvents(toneMidi), a4Hz);
          },
    },
    !finished,
  );

  const best = (b: { value: number } | null | undefined, now: number | null): string | undefined => {
    if (!b) return now !== null ? 'your first one: this is your best so far' : undefined;
    if (now !== null && now > b.value) return `longest so far (was ${seconds(b.value)}); only worth it if it felt easy`;
    return `your best: ${seconds(b.value)}`;
  };

  return (
    <section className="sing-screen" aria-label="Breath control">
      <ScreenHead
        title="Breath control"
        eyebrow="Breath"
        embedded={props.embedded}
        onExit={exit}
        lede="Steady, easy breath is what holds a note in tune. Work calmly: this is about control, not about running out of air."
      />
      <SafetyNote />
      <LiveRegion text={announce} />
      <ErrorNotice error={error} />

      {!finished && (
        <div className="sing-card">
          {!props.plan && (
            <fieldset className="segmented">
              <legend className="field-label">Exercise</legend>
              <div className="segmented-options">
                {parts.map((p) => (
                  <label key={p} className="segmented-option">
                    <input type="radio" name="breath-part" checked={part === p} disabled={busy} onChange={() => setPart(p)} />
                    <span>{PART_LABELS[p]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {props.plan && (
            <p className="sing-progress">
              {PART_LABELS[part]} ({partIndex + 1} of {parts.length})
            </p>
          )}

          {part === 'paced' && (
            <div className="sing-item">
              {pacedRunning ? (
                <BreathGuide plan={pacedPlan} onFinish={pacedDone} onStop={pacedDone} />
              ) : (
                <>
                  <p>
                    {pacedPlan.length} rounds. Breathe in through the nose for 4 counts, low and wide (belly and sides, not the shoulders). Pause gently for 4,
                    throat open. Then let the air out on a steady, quiet "sss" for {pacedPlan[0].exhale} counts, up to {pacedPlan[pacedPlan.length - 1].exhale} by the last round.
                    No microphone needed.
                  </p>
                  {paced && (
                    <div className="sing-result">
                      <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
                        {paced.rounds} {paced.rounds === 1 ? 'round' : 'rounds'} done
                      </h2>
                      <dl className="sing-stats">
                        <Stat label="Longest exhale" value={`${paced.maxExhaleCounts} counts`} note={best(bests.pacedExhaleCounts, paced.maxExhaleCounts)?.replace(/ s\b/g, ' counts')} />
                      </dl>
                    </div>
                  )}
                  <div className="button-row">
                    <button type="button" className={paced ? 'button' : 'button button--accent'} onClick={() => setPacedRunning(true)}>
                      {paced ? 'Go again' : 'Start'}
                      {desktop && !paced ? ' (Return)' : ''}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {part === 'hiss' && (
            <div className="sing-item">
              <p>
                Take one easy, low breath, then hiss a steady "sss" for as long as is comfortable. Stop while it still feels easy, not at the very last drop. Keep the
                hiss the same loudness all the way. Start hissing whenever you are ready after pressing Start; the app works out the room noise by itself.
              </p>
              <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint="It stops by itself when the hiss ends." />
              {take.phase === 'listening' && <LevelBar rmsDb={take.live?.rmsDb ?? null} />}
              {hiss && take.phase === 'idle' && (
                <div className="sing-result">
                  <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
                    {hiss.status === 'ok' ? `${seconds(hiss.durationSec)} of steady hiss` : 'Not scored'}
                  </h2>
                  {hiss.status === 'ok' ? (
                    <>
                      <dl className="sing-stats">
                        <Stat label="Length" value={seconds(hiss.durationSec)} note={best(bests.hissSec, hiss.durationSec)} />
                        <Stat label="Steadiness" value={hissSteadinessLabel(hiss.steadinessDb)} note={hiss.steadinessDb !== null ? `loudness varied by about ±${hiss.steadinessDb.toFixed(1)} dB` : undefined} />
                      </dl>
                      <Trace values={hiss.levelTrace} label="Hiss loudness over time" />
                    </>
                  ) : (
                    <p>
                      {hiss.status === 'voiced'
                        ? 'That sounded like a sung or spoken note rather than a hiss. Try an unvoiced "sss", like a slow tyre leak.'
                        : 'Too quiet to score: the hiss hardly rose above the room. Try a little louder or closer to the microphone.'}
                    </p>
                  )}
                  <FindingList findings={hiss.findings} />
                </div>
              )}
              {take.phase === 'idle' && (
                <div className="button-row">
                  <button type="button" className="button button--accent" onClick={() => void runHiss()}>
                    {hiss || error ? 'Try again' : 'Start'}
                    {desktop ? ' (Return)' : ''}
                  </button>
                </div>
              )}
            </div>
          )}

          {part === 'long-tone' && (
            <div className="sing-item">
              <p>
                Hold {noteName(toneMidi)} on "ah" or "oo" at a steady, medium volume for as long as is comfortable. Steady pitch and steady loudness both count; length
                comes with time.
              </p>
              <p className="sing-big">{noteName(toneMidi)}</p>
              <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint="It stops by itself when you stop singing." />
              {take.phase === 'listening' && (
                <>
                  <PitchNeedle centsNow={take.live?.midi != null ? foldCents((take.live.midi - toneMidi) * 100) : null} toleranceCents={toleranceFor(props)} />
                  <LevelBar rmsDb={take.live?.rmsDb ?? null} />
                </>
              )}
              {tone && take.phase === 'idle' && (
                <div className="sing-result">
                  <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
                    {tone.status === 'ok' ? `${seconds(tone.durationSec)} held` : 'Not scored'}
                  </h2>
                  {tone.status === 'ok' ? (
                    <>
                      <dl className="sing-stats">
                        <Stat label="Length" value={seconds(tone.durationSec)} note={best(bests.longToneSec, tone.durationSec)} />
                        <Stat label="Pitch" value={pitchSteadinessLabel(tone.pitchSdCents)} note={tone.pitchSdCents !== null ? `wandered about ±${centsCount(tone.pitchSdCents)} (vibrato not counted)` : undefined} />
                        <Stat label="Loudness" value={tone.loudnessSdDb !== null ? `±${tone.loudnessSdDb.toFixed(1)} dB` : '–'} note="smaller is steadier" />
                      </dl>
                      <Trace values={tone.pitchTrace} label="Pitch over time" />
                    </>
                  ) : (
                    <p>{tone.status === 'too-quiet' ? TOO_QUIET_TEXT : NO_PITCH_TEXT}</p>
                  )}
                  <FindingList findings={tone.findings} />
                </div>
              )}
              {take.phase === 'idle' && (
                <div className="button-row">
                  <button type="button" className="button button--accent" onClick={() => void runTone()}>
                    {tone || error ? 'Try again' : 'Play the note and sing'}
                    {desktop ? ' (Return)' : ''}
                  </button>
                  <button type="button" className="button button--ghost" onClick={() => void take.play(noteEvents(toneMidi), a4Hz)} disabled={busy}>
                    Hear it{desktop ? ' (Space)' : ''}
                  </button>
                </div>
              )}
            </div>
          )}

          {!busy && (
            <div className="button-row sing-part-nav">
              {props.plan && nextPart ? (
                <button type="button" className={pacedSetDone ? 'button button--accent' : 'button'} onClick={() => setPart(nextPart)}>
                  Next: {PART_LABELS[nextPart]}
                  {desktop && pacedSetDone ? ' (Return)' : ''}
                </button>
              ) : (
                <button type="button" className={pacedSetDone ? 'button button--accent' : 'button'} onClick={done}>
                  Done
                  {desktop && pacedSetDone ? ' (Return)' : ''}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {finished && (
        <div className="sing-card sing-summary">
          <h2 className="sing-result-title">Breath work done</h2>
          <dl className="sing-stats">
            {paced && <Stat label="Paced breathing" value={`${paced.rounds} rounds`} note={`longest exhale ${paced.maxExhaleCounts} counts`} />}
            {hiss?.status === 'ok' && <Stat label="Hiss" value={seconds(hiss.durationSec)} note={hissSteadinessLabel(hiss.steadinessDb)} />}
            {tone?.status === 'ok' && <Stat label="Long tone" value={seconds(tone.durationSec)} note={`pitch ${pitchSteadinessLabel(tone.pitchSdCents)}`} />}
          </dl>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={props.onExit}>
              {props.embedded ? 'Continue' : 'Back to Skills'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

