// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { decodeWav } from '../audio/wav';
import { clearPendingImport, clipNameKey, fileFromSamples, peekPendingImport, setPendingImport } from './trainerHandoff';

afterEach(() => clearPendingImport());

describe('trainer handoff', () => {
  it('holds files until they are cleared, and reading them does not use them up', () => {
    const f = new File(['x'], 'a.wav');
    setPendingImport([f]);
    expect(peekPendingImport()).toEqual([f]);
    expect(peekPendingImport()).toEqual([f]);
    clearPendingImport();
    expect(peekPendingImport()).toEqual([]);
  });

  it('copies the list it is given', () => {
    const list = [new File(['x'], 'a.wav')];
    setPendingImport(list);
    list.length = 0;
    expect(peekPendingImport()).toHaveLength(1);
  });

  it('makes a WAV file from decoded samples, named after the clip', async () => {
    const samples = new Float32Array(2205).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / 22050));
    const file = fileFromSamples('Best Part.m4a', samples, 22050);
    expect(file.name).toBe('Best Part.wav');
    expect(file.type).toBe('audio/wav');
    const back = decodeWav(await file.arrayBuffer());
    expect(back.sampleRate).toBe(22050);
    expect(back.channels[0]).toHaveLength(2205);
    expect(fileFromSamples('already.WAV', samples, 22050).name).toBe('already.WAV');
    expect(fileFromSamples('  ', samples, 22050).name).toBe('clip.wav');
  });

  it('compares clip names without the extension, case or spacing', () => {
    expect(clipNameKey('My  Song.M4A')).toBe(clipNameKey('my song'));
    expect(clipNameKey('a.b song')).toBe('a.b song');
  });
});
