// One "what to fix first" card, and the list of at most three. The card is the app's CoachingItemCard (through the
// fixToCoachingItem adapter) plus the trainer's own drill: a slow loop of the weak region. Exercise links open the Practice
// page for that exercise; nothing here asks for more rasp, grit or volume.

import type { JSX } from 'react';
import { getExercise } from '../../coach/exercises';
import { fixToCoachingItem, loopLabel, type TrainerFix } from '../../trainer/feedback';
import type { Exercise } from '../../types';
import { CoachingItemCard } from './CoachingItemCard';
import { Icon } from './Icon';
import './phraseCompare.css';

export interface FixCardProps {
  fix: TrainerFix;
  /** 0 for the first fix; sets the "Work on first / Next / Polish" chip. */
  rank?: number;
  /** Where exercise links go (the Practice page). */
  onOpenExercises: (ids: string[]) => void;
  /** Loop the weak region at the fix's rate. Without it the loop button is left out. */
  onLoop?: (loop: NonNullable<TrainerFix['loop']>, fix: TrainerFix) => void;
  lookupExercise?: (id: string) => Exercise | undefined;
}

const DIMENSION_LABEL: Record<TrainerFix['category'], string> = {
  pitch: 'Pitch',
  timing: 'Timing',
  duration: 'Note length',
  tempo: 'Tempo',
  tone: 'Tone and shaping',
  coverage: 'Completeness',
};

export function FixCard(props: FixCardProps): JSX.Element {
  const { fix } = props;
  return (
    <div className="fc">
      <CoachingItemCard
        item={fixToCoachingItem(fix, props.rank ?? 0)}
        dimensionLabel={DIMENSION_LABEL[fix.category]}
        lookupExercise={props.lookupExercise ?? getExercise}
        onOpenExercises={props.onOpenExercises}
      />
      {fix.loop && props.onLoop && (
        <div className="fc-actions">
          <button type="button" className="button button--ghost fc-loop" onClick={() => props.onLoop?.(fix.loop as NonNullable<TrainerFix['loop']>, fix)}>
            <Icon name="loop" size={18} /> {loopLabel(fix.loop)}
          </button>
        </div>
      )}
    </div>
  );
}

export interface FixListProps extends Omit<FixCardProps, 'fix' | 'rank'> {
  fixes: TrainerFix[];
  /** Why there are no fixes when the list is empty and the take was scored. Defaults to a "nothing stood out" line. */
  emptyText?: string;
}

/** The fixes in order, or a line saying why there are none, with the next step. */
export function FixList(props: FixListProps): JSX.Element {
  const { fixes, emptyText, ...card } = props;
  if (fixes.length === 0) {
    return <p className="viz-empty fc-empty">{emptyText ?? 'Nothing stood out to fix. Try it again at full speed, or move on to the next phrase.'}</p>;
  }
  return (
    <div className="fc-list">
      {fixes.slice(0, 3).map((f, i) => (
        <FixCard key={f.id} fix={f} rank={i} {...card} />
      ))}
    </div>
  );
}
