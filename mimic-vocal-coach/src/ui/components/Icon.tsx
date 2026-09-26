// Line icons for navigation and a few actions. Drawn on a 24-unit grid, stroked in currentColor.

import type { Route } from '../../state/routing';

export type IconName = Route | 'mic' | 'upload' | 'stop' | 'play' | 'download' | 'save' | 'close' | 'spark';

const PATHS: Record<IconName, string[]> = {
  studio: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21', 'M8.5 21h7'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21'],
  results: ['M3.5 16a8.5 8.5 0 0 1 17 0', 'M12 16l4.2-5.2', 'M3.5 20h17'],
  practice: ['M9 18V5.5l11-2V16', 'M9 9.5l11-2'],
  progress: ['M3.5 18.5l5.5-6 4 3.5 7.5-8.5', 'M15.5 7.5h5v5'],
  guide: ['M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v15H7a2.5 2.5 0 0 0-2.5 2.5z', 'M4.5 20.5V5.5', 'M8.5 7.5h7'],
  settings: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5'],
  upload: ['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M4.5 15v4.5h15V15'],
  stop: ['M7 7h10v10H7z'],
  play: ['M8 5.5v13l10.5-6.5z'],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M4.5 19.5h15'],
  save: ['M5 4.5h11l3.5 3.5v11.5H5z', 'M8.5 4.5v5h6v-5', 'M8.5 19.5v-5h7v5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  spark: ['M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z', 'M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
};

const FILLED: Partial<Record<IconName, true>> = { stop: true, play: true };

export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const size = props.size ?? 20;
  const filled = FILLED[props.name];
  const circles = props.name === 'practice' ? [
    [6.5, 18, 2.5],
    [17.5, 16, 2.5],
  ] : props.name === 'settings' ? [
    [15, 7, 2.2],
    [9, 17, 2.2],
  ] : [];
  return (
    <svg
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
      {circles.map(([cx, cy, r]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={props.name === 'practice' ? 'currentColor' : 'none'} />
      ))}
    </svg>
  );
}
