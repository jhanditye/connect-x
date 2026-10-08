// The last few scores of a phrase as a row of dots (oldest left), with the numbers in the accessible name. Decoration for the
// phrase list: the best score and the status word beside it say the same thing in text.

export function Spark(props: { scores: readonly number[]; className?: string }) {
  const scores = props.scores.filter((s) => Number.isFinite(s)).slice(-5);
  if (scores.length === 0) return null;
  const W = 44;
  const H = 20;
  const step = scores.length > 1 ? (W - 8) / (scores.length - 1) : 0;
  const y = (s: number) => 3 + (H - 6) * (1 - Math.max(0, Math.min(100, s)) / 100);
  const pts = scores.map((s, i) => ({ x: scores.length > 1 ? 4 + i * step : W / 2, y: y(s) }));
  return (
    <svg
      className={`spark${props.className ? ` ${props.className}` : ''}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Last ${scores.length === 1 ? 'score' : `${scores.length} scores`}: ${scores.map((s) => Math.round(s)).join(', ')}`}
    >
      {pts.length > 1 && <polyline className="spark-line" fill="none" points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} />}
      {pts.map((p, i) => (
        <circle key={i} className={`spark-dot${i === pts.length - 1 ? ' spark-dot--last' : ''}`} cx={p.x} cy={p.y} r={i === pts.length - 1 ? 3 : 2} />
      ))}
    </svg>
  );
}
