// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { decodeWav } from '../../audio/wav';
import { makeFakeClip, makeFakeTrainerController } from '../../testing/trainerFixtures';
import { useScreen } from '../../testing/trainerUi';
import { clearPendingImport, peekPendingImport } from '../trainerHandoff';
import { OpenInTrainer } from './OpenInTrainer';

const screen = useScreen();
const samples = new Float32Array(4410).map((_, i) => 0.4 * Math.sin((2 * Math.PI * 196 * i) / 22050));

const mount = (name: string, clips = [makeFakeClip()], extra: { hint?: string } = {}) =>
  screen.mount(<OpenInTrainer name={name} samples={samples} sampleRate={22050} addLabel="Practise this phrase by phrase" openLabel="Practise this phrase by phrase" {...extra} />, makeFakeTrainerController({ clips }));

describe('OpenInTrainer', () => {
  it('hands the decoded clip to the add sheet as a WAV file, and opens the sheet', async () => {
    clearPendingImport();
    mount('Isolated vocal');
    screen.click(screen.button(/Practise this phrase by phrase/));
    expect(window.location.hash).toBe('#trainer/add');
    const [file] = peekPendingImport();
    expect(file.name).toBe('Isolated vocal.wav');
    const wav = decodeWav(await file.arrayBuffer());
    expect(wav.sampleRate).toBe(22050);
    expect(wav.channels[0]).toHaveLength(4410);
    clearPendingImport();
  });

  it('links to the clip when the library already has one of that name (title or file name)', () => {
    mount('FAKE CLIP, 12 phrases');
    expect(screen.link(/Practise this phrase by phrase/).getAttribute('href')).toBe('#trainer/c/fake-clip');
    expect(screen.hasButton(/Practise/)).toBe(false);
    mount('fake-clip.m4a');
    expect(screen.link(/Practise/).getAttribute('href')).toBe('#trainer/c/fake-clip');
  });

  it('says "Open in Trainer" by default when it is a link', () => {
    screen.mount(<OpenInTrainer name="fake clip, 12 phrases" samples={samples} sampleRate={22050} addLabel="Add it" />, makeFakeTrainerController());
    expect(screen.link(/Open in Trainer/)).toBeTruthy();
  });

  it('shows its hint with the button', () => {
    mount('x', [], { hint: 'The clip stays on this device.' });
    expect(screen.q('.ref-trainer .field-hint').textContent).toBe('The clip stays on this device.');
  });

  it('renders nothing at all, hint included, when there is no Trainer', () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const root = createRoot(holder);
    act(() => root.render(<OpenInTrainer name="x" samples={samples} sampleRate={22050} addLabel="Add" hint="Never shown." />));
    expect(holder.innerHTML).toBe('');
    act(() => root.unmount());
    holder.remove();
  });
});
