// Range on a piano strip: the user's range (tessitura thicker), the singer's range and tessitura in
// the singer colour, and the passaggio zone shaded through both rows and the keys.

import type { JSX } from 'react';
import { midiToNoteName } from '../../dsp/music';
import type { PassaggioZone } from '../../types';
import { r1, useContainerWidth } from './chartKit';

const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
const ROW_H = 30; // label line + bar
const KEY_H = 46;
const LABEL_H = 16;
const TOP = 18; // room for the passaggio bracket label

export function isBlackKey(midi: number): boolean {
  return BLACK_PCS.has(((Math.round(midi) % 12) + 12) % 12);
}

export interface KeyRect {
  midi: number;
  black: boolean;
  x: number;
  w: number;
}

export interface KeyboardLayout {
  from: number;
  to: number;
  keys: KeyRect[];
  whiteW: number;
  /** Horizontal centre of a (rounded) MIDI note's key, clamped to the strip. */
  centre: (midi: number) => number;
}

/** Lays out white and black keys across `width` px. The strip always starts and ends on a white key. */
export function keyboardLayout(fromMidi: number, toMidi: number, width: number): KeyboardLayout {
  let from = Math.round(Math.min(fromMidi, toMidi));
  let to = Math.round(Math.max(fromMidi, toMidi));
  if (isBlackKey(from)) from -= 1;
  if (isBlackKey(to)) to += 1;
  const whites: number[] = [];
  for (let m = from; m <= to; m++) if (!isBlackKey(m)) whites.push(m);
  const whiteW = width / Math.max(1, whites.length);
  const blackW = whiteW * 0.6;
  const whiteIndex = new Map<number, number>(whites.map((m, i) => [m, i]));
  const keys: KeyRect[] = [];
  const centres = new Map<number, number>();
  for (let m = from; m <= to; m++) {
    if (!isBlackKey(m)) {
      const i = whiteIndex.get(m)!;
      keys.push({ midi: m, black: false, x: i * whiteW, w: whiteW });
      centres.set(m, (i + 0.5) * whiteW);
    }
  }
  for (let m = from + 1; m < to; m++) {
    if (isBlackKey(m)) {
      // A black key sits on the boundary between the white keys either side of it.
      const boundary = (whiteIndex.get(m + 1) ?? 0) * whiteW;
      keys.push({ midi: m, black: true, x: boundary - blackW / 2, w: blackW });
      centres.set(m, boundary);
    }
  }
  const centre = (midi: number) => {
    const m = Math.round(midi);
    if (m <= from) return centres.get(from)!;
    if (m >= to) return centres.get(to)!;
    return centres.get(m) ?? 0;
  };
  return { from, to, keys, whiteW, centre };
}

function rangeText(lo: number, hi: number): string {
  return `${midiToNoteName(lo)}–${midiToNoteName(hi)}`;
}

export function describeRange(p: {
  userLow: number | null;
  userHigh: number | null;
  userTessitura?: [number, number] | null;
  singerRange?: { lowMidi: number; highMidi: number; tessituraLowMidi: number; tessituraHighMidi: number };
  passaggio?: PassaggioZone;
  from: number;
  to: number;
}): string {
  const parts = [`Keyboard from ${midiToNoteName(p.from)} to ${midiToNoteName(p.to)}`];
  if (p.userLow !== null && p.userHigh !== null) {
    parts.push(`your range ${rangeText(p.userLow, p.userHigh)}${p.userTessitura ? `, mostly ${rangeText(p.userTessitura[0], p.userTessitura[1])}` : ''}`);
  } else parts.push('your range was not measured');
  if (p.singerRange) {
    parts.push(`singer range ${rangeText(p.singerRange.lowMidi, p.singerRange.highMidi)}, mostly ${rangeText(p.singerRange.tessituraLowMidi, p.singerRange.tessituraHighMidi)}`);
  }
  if (p.passaggio) parts.push(`passaggio ${rangeText(p.passaggio.lowMidi, p.passaggio.highMidi)}`);
  return `${parts.join('; ')}.`;
}

function RangeRow(props: {
  y: number;
  label: string;
  low: number | null;
  high: number | null;
  tess: [number, number] | null;
  color: string;
  layout: KeyboardLayout;
  emptyText: string;
}): JSX.Element {
  const { y, layout, color } = props;
  const barY = y + 20;
  if (props.low === null || props.high === null) {
    return (
      <g>
        <text className="viz-label" x={0} y={y + 11}>
          {props.label}
        </text>
        <text className="viz-note" x={0} y={barY + 4}>
          {props.emptyText}
        </text>
      </g>
    );
  }
  const x0 = layout.centre(props.low);
  const x1 = layout.centre(props.high);
  const tess = props.tess ? [layout.centre(props.tess[0]), layout.centre(props.tess[1])] : null;
  return (
    <g>
      <text className="viz-label" x={0} y={y + 11}>
        {props.label}{' '}
        <tspan className="viz-tick">
          {rangeText(props.low, props.high)}
          {props.tess ? `  (mostly ${rangeText(props.tess[0], props.tess[1])})` : ''}
        </tspan>
      </text>
      <line x1={r1(x0)} x2={r1(Math.max(x1, x0 + 0.1))} y1={barY} y2={barY} strokeLinecap="round" style={{ stroke: color, strokeWidth: 3 }} />
      {tess && (
        <line x1={r1(tess[0])} x2={r1(Math.max(tess[1], tess[0] + 0.1))} y1={barY} y2={barY} strokeLinecap="round" style={{ stroke: color, strokeWidth: 9 }} />
      )}
      <circle cx={r1(x0)} cy={barY} r={3.5} style={{ fill: color, stroke: 'var(--surface)', strokeWidth: 1.5 }} />
      <circle cx={r1(x1)} cy={barY} r={3.5} style={{ fill: color, stroke: 'var(--surface)', strokeWidth: 1.5 }} />
    </g>
  );
}

export function RangeKeyboard(props: {
  userLow: number | null;
  userHigh: number | null;
  userTessitura?: [number, number] | null;
  singerRange?: { lowMidi: number; highMidi: number; tessituraLowMidi: number; tessituraHighMidi: number };
  singerColor?: string;
  passaggio?: PassaggioZone;
  fromMidi?: number;
  toMidi?: number;
}): JSX.Element {
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(640);
  const width = Math.max(240, containerW);
  const layout = keyboardLayout(props.fromMidi ?? 40, props.toMidi ?? 84, width);
  const singerColor = props.singerColor ?? 'var(--singer-custom)';
  const rows = props.singerRange ? 2 : 1;
  const keysY = TOP + rows * ROW_H + 6;
  const height = keysY + KEY_H + LABEL_H;
  const pass = props.passaggio;
  const passX0 = pass ? layout.centre(pass.lowMidi) - layout.whiteW * 0.35 : 0;
  const passX1 = pass ? layout.centre(pass.highMidi) + layout.whiteW * 0.35 : 0;
  const cLabels = layout.keys.filter((k) => !k.black && ((k.midi % 12) + 12) % 12 === 0);
  const tess = props.userTessitura ?? null;

  return (
    <div className="viz rangekb" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={describeRange({
          userLow: props.userLow,
          userHigh: props.userHigh,
          userTessitura: tess,
          singerRange: props.singerRange,
          passaggio: pass,
          from: layout.from,
          to: layout.to,
        })}
      >
        {pass && passX1 > passX0 && (
          <g>
            <rect x={r1(passX0)} y={TOP - 4} width={r1(passX1 - passX0)} height={keysY + KEY_H - TOP + 4} style={{ fill: 'var(--reg-mix)', fillOpacity: 0.1 }} />
            <path
              d={`M${r1(passX0)} ${TOP}V${TOP - 5}H${r1(passX1)}V${TOP}`}
              fill="none"
              style={{ stroke: 'var(--reg-mix)', strokeWidth: 1.5 }}
            />
            <text className="viz-note" x={r1((passX0 + passX1) / 2)} y={TOP - 8} textAnchor="middle">
              passaggio
            </text>
          </g>
        )}

        <RangeRow
          y={TOP}
          label="You"
          low={props.userLow}
          high={props.userHigh}
          tess={tess}
          color="var(--accent)"
          layout={layout}
          emptyText="Not enough steady singing to measure a range."
        />
        {props.singerRange && (
          <RangeRow
            y={TOP + ROW_H}
            label="Singer"
            low={props.singerRange.lowMidi}
            high={props.singerRange.highMidi}
            tess={[props.singerRange.tessituraLowMidi, props.singerRange.tessituraHighMidi]}
            color={singerColor}
            layout={layout}
            emptyText=""
          />
        )}

        <g className="rangekb-keys">
          {layout.keys
            .filter((k) => !k.black)
            .map((k) => (
              <rect key={k.midi} className="rangekb-white" x={r1(k.x)} y={keysY} width={r1(k.w)} height={KEY_H} rx={2} />
            ))}
          {layout.keys
            .filter((k) => k.black)
            .map((k) => (
              <rect key={k.midi} className="rangekb-black" x={r1(k.x)} y={keysY} width={r1(k.w)} height={KEY_H * 0.6} rx={1.5} />
            ))}
          {pass && passX1 > passX0 && (
            <rect x={r1(passX0)} y={keysY} width={r1(passX1 - passX0)} height={KEY_H} style={{ fill: 'var(--reg-mix)', fillOpacity: 0.14 }} pointerEvents="none" />
          )}
        </g>
        {cLabels.map((k) => (
          <text key={k.midi} className="viz-tick" x={r1(k.x + k.w / 2)} y={keysY + KEY_H + 12} textAnchor="middle">
            {midiToNoteName(k.midi)}
          </text>
        ))}
      </svg>
      <ul className="viz-legend" aria-label="Range key">
        <li>
          <span className="viz-key viz-key--range" style={{ background: 'var(--accent)' }} aria-hidden="true" /> Your range (thick: where you mostly sang)
        </li>
        {props.singerRange && (
          <li>
            <span className="viz-key viz-key--range" style={{ background: singerColor }} aria-hidden="true" /> Singer’s typical range
          </li>
        )}
        {pass && (
          <li>
            <span className="viz-key viz-key--band" aria-hidden="true" /> Passaggio
          </li>
        )}
      </ul>
    </div>
  );
}
