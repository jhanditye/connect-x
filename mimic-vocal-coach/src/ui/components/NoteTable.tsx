// The note-by-note table of one attempt: the original note, what you sang, and pitch / timing / length with a word for
// anything that cost points (the words come from the scorer's settled flags, so a flag here is a charge in the score).
// Five columns so it fits a 320 px phone; a row is a 44 px button (the parent decides what a tap does, for example
// looping that note at 75 %). Colour is never the only cue: every flagged cell carries its word.

import type { JSX } from 'react';
import type { NoteCompare, PhraseComparison } from '../../types';
import { Icon } from './Icon';
import { Notice } from './Notice';
import { flagWord, formatMs, isFlagged, isSevereFlag, lengthFlag, noteSummary, outsideTrackerRange, pitchFigure, pitchFlag, timingFlag } from './noteWords';
import './phraseCompare.css';

export interface NoteTableProps {
  comparison: PhraseComparison;
  /** Reference note index highlighted (shared with the overlay plot). */
  selected?: number | null;
  /** A tap on a row. Without it the rows are not interactive. */
  onSelect?: (note: NoteCompare) => void;
  /** What a tap does, for screen readers: "Loops this note at 75 percent". */
  actionHint?: string;
}

type Tone = 'good' | 'warn' | 'bad' | 'none';

interface Cell {
  figure: string;
  word: string | null;
  tone: Tone;
}

const dash: Cell = { figure: '–', word: null, tone: 'none' };

function youCell(n: NoteCompare): Cell {
  if (!n.matched || n.flags.includes('missed')) return outsideTrackerRange(n) ? { figure: '–', word: 'out of range', tone: 'warn' } : { figure: '–', word: 'missed', tone: 'bad' };
  const sev = n.flags.find(isSevereFlag);
  if (sev) return { figure: n.userName ?? '–', word: flagWord(sev), tone: 'bad' };
  if (n.flags.includes('merged')) return { figure: n.userName ?? '–', word: flagWord('merged'), tone: 'warn' };
  return { figure: n.userName ?? '–', word: null, tone: 'none' };
}

function pitchCell(n: NoteCompare): Cell {
  if (!n.matched) return dash;
  const f = pitchFlag(n);
  const word = f === 'flat' || f === 'sharp' ? flagWord(f) : null;
  return { figure: pitchFigure(n), word, tone: f === 'wrong-note' || f === 'octave-displaced' ? 'bad' : word ? 'warn' : 'none' };
}

function timingCell(n: NoteCompare): Cell {
  if (!n.matched || n.onsetMs === null) return dash;
  const f = timingFlag(n);
  return { figure: formatMs(n.onsetMs), word: f ? flagWord(f) : null, tone: f ? 'warn' : 'none' };
}

function lengthCell(n: NoteCompare): Cell {
  if (!n.matched || n.durationDeltaMs === null) return dash;
  const f = lengthFlag(n);
  return { figure: formatMs(n.durationDeltaMs), word: f ? flagWord(f) : null, tone: f ? 'warn' : 'none' };
}

function CellView(props: { cell: Cell; ok?: boolean }): JSX.Element {
  const { cell } = props;
  return (
    <td className={`nt-cell nt-cell--${cell.tone}`}>
      <span className="nt-figure num">{cell.figure}</span>
      {cell.word ? (
        <span className="nt-word">{cell.word}</span>
      ) : props.ok ? (
        <span className="nt-word nt-word--ok">
          <Icon name="check" size={12} /> ok
        </span>
      ) : null}
    </td>
  );
}

export function NoteTable(props: NoteTableProps): JSX.Element {
  const { comparison: c } = props;
  const rows = c.notes;

  if (rows.length === 0) {
    return (
      <p className="viz-empty" role="status">
        There are no sung notes in this phrase to compare. Open the phrase editor and pick a part with singing in it.
      </p>
    );
  }
  if (c.score.status !== 'ok') {
    return (
      <p className="viz-empty" role="status">
        {c.score.status === 'no-match'
          ? 'This take did not line up with the phrase, so there is no note-by-note view. Listen to the original once more, then try again.'
          : 'There was too little singing in this take for a note-by-note view. Check your microphone, then try again.'}
      </p>
    );
  }

  const speech = c.score.kind === 'speech-like';
  const caption = `Your take against the original, note by note: ${rows.filter(isFlagged).length} of ${rows.length} to work on.`;
  return (
    <div className="nt">
      {speech && (
        <Notice tone="info" title="Speech-like phrase">
          Only the rhythm and the rise and fall of the voice are compared, not exact notes, so pitch figures are left out.
        </Notice>
      )}
      <table className="nt-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="nt-h nt-h--note">
              Note
            </th>
            <th scope="col" className="nt-h">
              You
            </th>
            <th scope="col" className="nt-h">
              Pitch
            </th>
            <th scope="col" className="nt-h">
              Timing
            </th>
            <th scope="col" className="nt-h">
              Length
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => {
            const sel = props.selected === n.refIndex;
            const flagged = isFlagged(n);
            const label = `${noteSummary(n)}${props.actionHint ? `. ${props.actionHint}` : ''}`;
            const sung = n.matched && !n.flags.includes('missed');
            return (
              <tr key={n.refIndex} className={`nt-row${sel ? ' nt-row--selected' : ''}${flagged ? ' nt-row--flagged' : ''}`}>
                <th scope="row" className="nt-name">
                  {props.onSelect ? (
                    <button type="button" className="nt-button" aria-pressed={sel} aria-label={`Note ${n.refIndex + 1}. ${label}`} onClick={() => props.onSelect?.(n)}>
                      <span className="nt-index num">{n.refIndex + 1}</span>
                      <span className="nt-note num">{n.refName}</span>
                    </button>
                  ) : (
                    <span className="nt-static" aria-label={`Note ${n.refIndex + 1}. ${noteSummary(n)}`}>
                      <span className="nt-index num">{n.refIndex + 1}</span>
                      <span className="nt-note num">{n.refName}</span>
                    </span>
                  )}
                </th>
                <CellView cell={youCell(n)} ok={sung && !flagged} />
                <CellView cell={speech ? dash : pitchCell(n)} />
                <CellView cell={timingCell(n)} />
                <CellView cell={lengthCell(n)} />
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="nt-foot">
        Pitch is in cents against the right note in your key; timing and length are against the original once your overall delay and speed are taken out. Differences that cost almost nothing are shown but not marked.
      </p>
    </div>
  );
}
