// The audio of a stored clip for the phrase editor on the clip screen: its samples (the vocal-only file when there is one, else the
// song) and the analysis that draws the pitch line under them. Loaded only while the editor is open and released when it closes, so a
// four-minute clip is not held in memory while you browse. A result that arrives after the editor closed, or for another clip, is
// dropped.

import { useEffect, useState } from 'react';
import { analyzeInWorker } from '../../analysis/client';
import { phraseAnalysisOptions } from '../../trainer/phraseAnalysis';
import type { TrainerController } from '../../state/trainerContext';
import type { ClipRecord, VoiceAnalysis } from '../../types';

export interface ClipAudioView {
  status: 'idle' | 'loading' | 'ready' | 'error';
  samples: Float32Array | null;
  sampleRate: number;
  analysis: VoiceAnalysis | null;
  message: string | null;
}

const IDLE: ClipAudioView = { status: 'idle', samples: null, sampleRate: 0, analysis: null, message: null };

export function useClipAudio(trainer: Pick<TrainerController, 'readClipSamples'>, clip: ClipRecord | undefined, enabled: boolean): ClipAudioView {
  const [view, setView] = useState<ClipAudioView>(IDLE);
  const read = trainer.readClipSamples;
  const id = clip?.id;
  const missing = clip?.audioMissing ?? true;
  const kind = clip?.analysisKind;
  const voiceType = clip?.analysis.voiceType;
  const a4Hz = clip?.analysis.a4Hz;

  useEffect(() => {
    if (!enabled || !id || missing || !read || !voiceType) {
      setView(IDLE);
      return;
    }
    let live = true;
    setView({ ...IDLE, status: 'loading' });
    void (async () => {
      try {
        const data = await read(id);
        if (!live) return;
        if (!data) {
          setView(IDLE);
          return;
        }
        const opts = phraseAnalysisOptions({ analysisKind: kind ?? 'solo' }, { source: data.source }, { voiceType, a4Hz });
        const analysis = await analyzeInWorker(data.samples, data.sampleRate, opts);
        if (live) setView({ status: 'ready', samples: data.samples, sampleRate: data.sampleRate, analysis, message: null });
      } catch (err) {
        if (live) setView({ ...IDLE, status: 'error', message: err instanceof Error && err.message ? err.message : 'The audio could not be read.' });
      }
    })();
    return () => {
      live = false;
    };
  }, [enabled, id, missing, read, kind, voiceType, a4Hz]);

  return view;
}
