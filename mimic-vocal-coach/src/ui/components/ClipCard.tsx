// One clip in the library: a link to its detail page showing the singer colour, title, length, how many phrases are mastered
// (as text and as a bar) and anything that needs attention (full song, audio missing, reviews due). The whole card is the
// tap target (an <a>, so it also works with a keyboard and opens in the same tab).

import type { CSSProperties } from 'react';
import { trainerHash } from '../../state/routing';
import type { ClipRecord, SingerProfile } from '../../types';
import { Icon } from './Icon';
import { clipLength, phraseCount, summariseClip } from './phraseStatus';
import { singerColor } from './singer';

export interface ClipCardProps {
  clip: ClipRecord;
  singer?: SingerProfile | null;
  /** Clock for "review due" (ms since epoch). */
  now: number;
}

/** The colour of a clip's singer: a builtin singer's token, or the custom-singer colour for "someone else". */
export function clipColor(singer: SingerProfile | null | undefined): string {
  return singer ? singerColor(singer) : 'var(--singer-custom)';
}

export function ClipCard(props: ClipCardProps) {
  const { clip, singer, now } = props;
  const s = summariseClip(clip, now);
  const style = { '--clip-color': clipColor(singer), '--done': `${s.total ? (s.mastered / s.total) * 100 : 0}%`, '--doing': `${s.total ? ((s.mastered + s.learning) / s.total) * 100 : 0}%` } as CSSProperties;
  const progress =
    s.total === 0
      ? 'No phrases yet'
      : `${s.mastered} of ${s.total} mastered${s.learning > 0 ? `, ${s.learning} in progress` : ''}`;
  return (
    <a className="cc" href={trainerHash({ view: 'clip', clipId: clip.id })} style={style}>
      <span className="cc-top">
        <span className="cc-dot" aria-hidden="true" />
        <span className="cc-title">{clip.title}</span>
      </span>
      <span className="cc-meta">
        <span className="num">{phraseCount(s.total)}</span>
        <span aria-hidden="true"> · </span>
        <span className="num">{clipLength(clip.durationSec)}</span>
        {clip.kind === 'mix' && <span className="cc-badge">Full song</span>}
        {s.reviewDue > 0 && (
          <span className="cc-badge cc-badge--due">
            {s.reviewDue} to review
          </span>
        )}
      </span>
      {clip.audioMissing ? (
        <span className="cc-alert">
          <Icon name="alert" size={16} /> Needs the file again
        </span>
      ) : (
        <>
          <span className="cc-bar" aria-hidden="true">
            <span className="cc-bar-doing" />
            <span className="cc-bar-done" />
          </span>
          <span className="cc-progress">{progress}</span>
        </>
      )}
    </a>
  );
}
