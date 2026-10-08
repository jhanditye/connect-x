// The word for a phrase's state ("New", "Learning", "Mastered", "Review due", "Stuck") as a small chip. The text carries the
// meaning; the colour only adds to it.

import type { PhraseStatus } from '../../trainer/srs';
import { STATUS_HINT, STATUS_LABEL } from './phraseStatus';

export function StatusChip(props: { status: PhraseStatus; className?: string }) {
  return (
    <span className={`sc sc--${props.status}${props.className ? ` ${props.className}` : ''}`} title={STATUS_HINT[props.status]}>
      {STATUS_LABEL[props.status]}
    </span>
  );
}
