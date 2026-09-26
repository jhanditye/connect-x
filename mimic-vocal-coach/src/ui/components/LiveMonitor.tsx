// Live feedback while recording: level meter, tuner (note + cents) and a scrolling pitch trace.
// Polls the recorder's AnalyserNode at ~20 fps; the pitch comes from the same single-frame YIN the
// analysis uses, so what the tuner shows agrees with the results.

import { useEffect, useRef, useState } from 'react';
import { detectPitch } from '../../dsp/pitch';
import { midiToNoteName } from '../../dsp/music';
import { formatCents, tunerReading } from './format';
import { LEVEL_TEXT, blockLevel, levelState, meterFraction, traceWindow, type LevelState } from './live';

const FRAME_MS = 50;
const TRACE_SEC = 8;
// Sung range limits for the tuner: below ~70 Hz and above ~1.1 kHz a phone mic in a room mostly
// picks up hum and whistles, not voice.
const MIN_HZ = 70;
const MAX_HZ = 1100;

interface Reading {
  rmsDb: number;
  level: LevelState;
  note: { name: string; cents: number } | null;
}

interface TracePoint {
  t: number;
  midi: number;
}

/** A design token's value; falls back to the element's text colour (tokens.css is always loaded, so only in odd embeds). */
function cssVar(cs: CSSStyleDeclaration, name: string): string {
  return cs.getPropertyValue(name).trim() || cs.color;
}

function drawTrace(canvas: HTMLCanvasElement, trace: TracePoint[], now: number, fallbackCentre: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { lo, hi } = traceWindow(
    trace.map((p) => p.midi),
    fallbackCentre,
  );
  const y = (m: number) => h - ((m - lo) / (hi - lo)) * h;
  const x = (t: number) => w - ((now - t) / TRACE_SEC) * w;

  const cs = getComputedStyle(canvas);
  const grid = cssVar(cs, '--grid');
  const gridStrong = cssVar(cs, '--grid-strong');
  const label = cssVar(cs, '--ink-3');
  const line = cssVar(cs, '--accent');
  const mono = cs.getPropertyValue('--font-mono').trim() || 'monospace';

  ctx.lineWidth = 1;
  ctx.font = `10px ${mono}`;
  ctx.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    const named = pc === 0 || pc === 4 || pc === 7; // C, E, G: enough landmarks without clutter
    ctx.strokeStyle = named ? gridStrong : grid;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(m)) + 0.5);
    ctx.lineTo(w, Math.round(y(m)) + 0.5);
    ctx.stroke();
    if (named) {
      ctx.fillStyle = label;
      ctx.fillText(midiToNoteName(m), 4, y(m) - 7);
    }
  }

  ctx.strokeStyle = line;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let pen = false;
  let prev = NaN;
  for (const p of trace) {
    // Break the line on unvoiced frames and on jumps of more than a fifth (a new note, not a glide).
    if (!Number.isFinite(p.midi) || (Number.isFinite(prev) && Math.abs(p.midi - prev) > 7)) {
      pen = false;
      prev = p.midi;
      if (!Number.isFinite(p.midi)) continue;
    }
    const px = x(p.t);
    const py = y(Math.max(lo, Math.min(hi, p.midi)));
    if (pen) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
    pen = true;
    prev = p.midi;
  }
  ctx.stroke();

  // Dots as well as the line, so a note only a frame or two long (a staccato hit) still shows.
  ctx.fillStyle = line;
  for (const p of trace) {
    if (!Number.isFinite(p.midi)) continue;
    ctx.beginPath();
    ctx.arc(x(p.t), y(Math.max(lo, Math.min(hi, p.midi))), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function LiveMonitor(props: { analyser: AnalyserNode; a4Hz: number; centreMidi: number }) {
  const [reading, setReading] = useState<Reading>({ rmsDb: -120, level: 'silent', note: null });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { analyser, a4Hz, centreMidi } = props;

  useEffect(() => {
    const buf = new Float32Array(analyser.fftSize);
    const trace: TracePoint[] = [];
    const rate = analyser.context.sampleRate;
    let raf = 0;
    let last = 0;
    const tick = (nowMs: number) => {
      raf = requestAnimationFrame(tick);
      if (nowMs - last < FRAME_MS) return;
      last = nowMs;
      analyser.getFloatTimeDomainData(buf);
      const { rmsDb, peak } = blockLevel(buf);
      const pitch = rmsDb > -60 ? detectPitch(buf, rate, MIN_HZ, MAX_HZ) : null;
      const tuned = pitch ? tunerReading(pitch.hz, a4Hz) : null;
      const now = nowMs / 1000;
      trace.push({ t: now, midi: tuned ? tuned.midi + tuned.cents / 100 : NaN });
      while (trace.length && now - trace[0].t > TRACE_SEC) trace.shift();
      setReading({ rmsDb, level: levelState(rmsDb, peak), note: tuned ? { name: tuned.name, cents: tuned.cents } : null });
      if (canvasRef.current) drawTrace(canvasRef.current, trace, now, centreMidi);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [analyser, a4Hz, centreMidi]);

  const cents = reading.note?.cents ?? 0;
  const inTune = reading.note !== null && Math.abs(cents) <= 15;
  return (
    <div className="live">
      <div className="live-row">
        <div className="tuner" role="group" aria-label="Live tuner">
          <span className={`tuner-note num${reading.note ? '' : ' tuner-note--idle'}`}>{reading.note ? reading.note.name : '–'}</span>
          <div className="tuner-scale" aria-hidden="true">
            <span className="tuner-centre" />
            {reading.note && (
              <span className={`tuner-needle${inTune ? ' tuner-needle--in' : ''}`} style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} />
            )}
          </div>
          <span className="tuner-cents num">{reading.note ? formatCents(cents) : 'listening'}</span>
        </div>
        <div className="level">
          <div className="level-track" aria-hidden="true">
            <span className="level-zone" />
            <span className={`level-fill level-fill--${reading.level}`} style={{ width: `${meterFraction(reading.rmsDb) * 100}%` }} />
          </div>
          <span className={`level-text level-text--${reading.level}`}>{LEVEL_TEXT[reading.level]}</span>
        </div>
      </div>
      <canvas ref={canvasRef} className="live-trace" role="img" aria-label="Scrolling pitch trace of the last eight seconds" />
    </div>
  );
}
