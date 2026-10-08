// Line icons for navigation and a few actions. Drawn on a 24-unit grid, stroked in currentColor.

import type { Route } from '../../state/routing';

export type IconName =
  | Route
  | 'mic'
  | 'upload'
  | 'stop'
  | 'play'
  | 'pause'
  | 'download'
  | 'save'
  | 'close'
  | 'spark'
  | 'add'
  | 'back'
  | 'forward'
  | 'chevron-up'
  | 'chevron-down'
  | 'loop'
  | 'trash'
  | 'edit'
  | 'headphones'
  | 'check'
  | 'alert'
  | 'info'
  | 'help'
  | 'split'
  | 'merge'
  | 'file';

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
  trainer: ['M4 10v4', 'M8 6.5v11', 'M12 9v6', 'M16 4.5v15', 'M20 9.5v5'],
  more: [],
  pause: ['M8.5 5v14', 'M15.5 5v14'],
  add: ['M12 5v14', 'M5 12h14'],
  back: ['M15 5l-7 7 7 7'],
  forward: ['M9 5l7 7-7 7'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  loop: ['M17 2.5l3 3-3 3', 'M4 11V9.5a4 4 0 0 1 4-4h12', 'M7 21.5l-3-3 3-3', 'M20 13v1.5a4 4 0 0 1-4 4H4'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10 11v5', 'M14 11v5'],
  edit: ['M4 20l1-4.5L16.5 4a2 2 0 0 1 3 3L8 18.5z', 'M14.5 6l3.5 3.5'],
  headphones: ['M4 14.5V12a8 8 0 0 1 16 0v2.5', 'M4 14.5h3v5.5H6a2 2 0 0 1-2-2z', 'M20 14.5h-3v5.5h1a2 2 0 0 0 2-2z'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alert: ['M12 3.5l9.5 16.5h-19z', 'M12 10v4.5', 'M12 17.4h.01'],
  info: ['M12 11v5.5', 'M12 7.7h.01'],
  help: ['M9.3 9.5a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.2.9-1.2 1.8', 'M12 17.4h.01'],
  split: ['M12 3.5v17', 'M7.5 8.5L3.5 12l4 3.5', 'M16.5 8.5l4 3.5-4 3.5'],
  merge: ['M3 12h6', 'M21 12h-6', 'M6.5 8.5L10 12l-3.5 3.5', 'M17.5 8.5L14 12l3.5 3.5'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 13h6', 'M9 17h6'],
  spark: ['M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z', 'M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
};

/** Circles drawn on top of the paths: [cx, cy, r]. Filled for the note-head and dots icons. */
const CIRCLES: Partial<Record<IconName, [number, number, number][]>> = {
  practice: [
    [6.5, 18, 2.5],
    [17.5, 16, 2.5],
  ],
  settings: [
    [15, 7, 2.2],
    [9, 17, 2.2],
  ],
  more: [
    [5.5, 12, 1.6],
    [12, 12, 1.6],
    [18.5, 12, 1.6],
  ],
  info: [[12, 12, 9]],
  help: [[12, 12, 9]],
};

const FILLED: Partial<Record<IconName, true>> = { stop: true, play: true };

export function Icon(props: { name: IconName; size?: number; className?: string }) {
  const size = props.size ?? 20;
  const filled = FILLED[props.name];
  const circles = CIRCLES[props.name] ?? [];
  const solid = props.name === 'practice' || props.name === 'more';
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
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={solid ? 'currentColor' : 'none'} />
      ))}
    </svg>
  );
}
