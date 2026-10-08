// "Open in Trainer": takes the reference clip the Studio and Results already hold into the Trainer, to practise phrase by phrase.
// If the library has a clip of the same name it opens that one; otherwise it hands the decoded sound to the Add clips sheet as a
// WAV file, so the person does not have to find the file again. Nothing leaves the device. Renders nothing when there is no Trainer.

import { useContext } from 'react';
import { goTrainer, trainerHash } from '../../state/routing';
import { TrainerContext } from '../../state/trainerContext';
import { clipNameKey, fileFromSamples, setPendingImport } from '../trainerHandoff';
import { Icon } from './Icon';

export interface OpenInTrainerProps {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  /** Label when the clip is not in the library yet. */
  addLabel: string;
  /** Label when the library already has it (default "Open in Trainer"). */
  openLabel?: string;
  className?: string;
  /** A sentence shown under the button (and only when the button is). */
  hint?: string;
}

export function OpenInTrainer(props: OpenInTrainerProps) {
  const trainer = useContext(TrainerContext);
  if (!trainer) return null;
  const key = clipNameKey(props.name);
  const existing = trainer.clips.find((c) => clipNameKey(c.title) === key || clipNameKey(c.sourceFileName) === key);
  const cls = props.className ?? 'button button--ghost button--small';
  const control = existing ? (
    <a className={cls} href={trainerHash({ view: 'clip', clipId: existing.id })}>
      <Icon name="trainer" size={16} /> {props.openLabel ?? 'Open in Trainer'}
    </a>
  ) : (
    <button
      type="button"
      className={cls}
      onClick={() => {
        setPendingImport([fileFromSamples(props.name, props.samples, props.sampleRate)]);
        goTrainer({ view: 'add' });
      }}
    >
      <Icon name="trainer" size={16} /> {props.addLabel}
    </button>
  );
  if (!props.hint) return control;
  return (
    <div className="ref-trainer">
      {control}
      <p className="field-hint">{props.hint}</p>
    </div>
  );
}
