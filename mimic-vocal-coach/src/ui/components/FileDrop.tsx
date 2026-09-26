// File picker with drag-and-drop. The real <input type="file"> stays in the tab order (visually
// hidden) so keyboard and screen-reader users get the native control.

import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { AUDIO_ACCEPT } from '../../audio/decode';
import { Icon } from './Icon';

const AUDIO_EXT = /\.(wav|wave|mp3|m4a|aac|ogg|oga|opus|webm|flac|caf|mp4|aiff?)$/i;

/** Accepts audio/* and video/* (phones label some voice memos as video/mp4) or a known extension. */
export function looksLikeAudio(file: Pick<File, 'name' | 'type'>): boolean {
  return /^(audio|video)\//.test(file.type) || AUDIO_EXT.test(file.name);
}

export function FileDrop(props: {
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  onFile: (file: File) => void;
  onReject?: (message: string) => void;
  compact?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (!file) return;
    if (!looksLikeAudio(file)) {
      props.onReject?.(`"${file.name}" does not look like an audio file. Use WAV, MP3, M4A, AAC, OGG, WebM or FLAC.`);
      return;
    }
    props.onFile(file);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!props.disabled) take(e.dataTransfer?.files);
  };

  return (
    <div
      className={`filedrop${over ? ' filedrop--over' : ''}${props.compact ? ' filedrop--compact' : ''}${props.disabled ? ' filedrop--disabled' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!props.disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        id={id}
        className="visually-hidden"
        type="file"
        accept={AUDIO_ACCEPT}
        disabled={props.disabled}
        onChange={(e) => {
          take(e.currentTarget.files);
          // Reset so choosing the same file again still fires onChange.
          e.currentTarget.value = '';
        }}
      />
      <label htmlFor={id} className="filedrop-label">
        <Icon name="upload" size={20} />
        <span className="filedrop-text">
          <span className="filedrop-title">{props.label}</span>
          {props.hint && <span className="filedrop-hint">{props.hint}</span>}
        </span>
      </label>
    </div>
  );
}
