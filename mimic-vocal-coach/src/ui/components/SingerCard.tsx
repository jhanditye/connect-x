import type { CSSProperties, ReactNode } from 'react';
import type { SingerProfile } from '../../types';
import { singerColor } from './singer';

/** A selectable singer. The singer's colour arrives through --card-color so the CSS stays token-only. */
export function SingerCard(props: {
  profile: SingerProfile;
  selected: boolean;
  onSelect: () => void;
  footer?: ReactNode;
}) {
  const style = { '--card-color': singerColor(props.profile) } as CSSProperties;
  return (
    <button type="button" className="singer-card" aria-pressed={props.selected} onClick={props.onSelect} style={style}>
      <span className="singer-card-swatch" aria-hidden="true" />
      <span className="singer-card-name">{props.profile.name}</span>
      <span className="singer-card-tagline">{props.profile.tagline}</span>
      {props.footer && <span className="singer-card-footer">{props.footer}</span>}
    </button>
  );
}

/** The "use a reference clip" slot in the singer picker. `unusable`: a clip is loaded but can't be a target. */
export function ReferenceCard(props: { loadedName: string | null; unusable?: boolean; selected: boolean; onSelect: () => void }) {
  const style = { '--card-color': 'var(--singer-custom)' } as CSSProperties;
  return (
    <button type="button" className="singer-card singer-card--reference" aria-pressed={props.selected} onClick={props.onSelect} style={style}>
      <span className="singer-card-swatch" aria-hidden="true" />
      <span className="singer-card-name">Reference clip</span>
      <span className="singer-card-tagline">
        {props.loadedName ? (
          props.unusable ? (
            <>
              <span className="singer-card-file">{props.loadedName}</span> can’t be used as a target: see why below
            </>
          ) : (
            <>
              Calibrated from <span className="singer-card-file">{props.loadedName}</span>
            </>
          )
        ) : (
          'Measure the target from a recording you own'
        )}
      </span>
    </button>
  );
}
