import type { CoachingItem, Exercise } from '../../types';

const PRIORITY_TEXT: Record<CoachingItem['priority'], string> = {
  1: 'Work on first',
  2: 'Next',
  3: 'Polish',
};

export function CoachingItemCard(props: {
  item: CoachingItem;
  dimensionLabel?: string;
  lookupExercise: (id: string) => Exercise | undefined;
  onOpenExercises: (ids: string[]) => void;
}) {
  const { item } = props;
  const exercises = item.exerciseIds.map((id) => ({ id, ex: props.lookupExercise(id) })).filter((e) => e.ex);
  const headingId = `coach-${item.id}`;
  return (
    <article className={`coach-card coach-card--p${item.priority}`} aria-labelledby={headingId}>
      <div className="coach-card-head">
        <span className={`chip chip--p${item.priority}`}>{PRIORITY_TEXT[item.priority]}</span>
        {props.dimensionLabel && <span className="coach-card-dim">{props.dimensionLabel}</span>}
      </div>
      <h3 id={headingId} className="coach-card-title">
        {item.title}
      </h3>
      <dl className="coach-card-body">
        <div>
          <dt>What we heard</dt>
          <dd>{item.whatWeHeard}</dd>
        </div>
        <div>
          <dt>Why it matters</dt>
          <dd>{item.whyItMatters}</dd>
        </div>
      </dl>
      {item.howToFix.length > 0 && (
        <>
          <p className="coach-card-sub">How to fix it</p>
          <ul className="coach-card-fixes">
            {item.howToFix.map((cue) => (
              <li key={cue}>{cue}</li>
            ))}
          </ul>
        </>
      )}
      {exercises.length > 0 && (
        <div className="coach-card-exercises">
          <p className="coach-card-sub">Exercises</p>
          <div className="coach-card-exlist">
            {exercises.map(({ id, ex }) => (
              <span key={id} className="coach-card-ex">
                <button type="button" className="link-button" onClick={() => props.onOpenExercises([id])}>
                  {ex!.name}
                </button>
                {ex!.durationMin > 0 && <span className="num muted"> {ex!.durationMin} min</span>}
              </span>
            ))}
            {exercises.length > 1 && (
              <button type="button" className="button button--ghost button--small" onClick={() => props.onOpenExercises(exercises.map((e) => e.id))}>
                Practise all {exercises.length}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
