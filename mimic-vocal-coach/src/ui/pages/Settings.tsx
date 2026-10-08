// Settings: voice type (drives the passaggio), tuning, AI coach key/model, theme, clear data.

import { useContext, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { passaggioFor, VOICE_TYPE_LABELS, VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { DEFAULT_AI_MODEL } from '../../coach/ai';
import { midiToNoteName } from '../../dsp/music';
import { useApp } from '../../state/context';
import { TrainerContext } from '../../state/trainerContext';
import { A4_MAX, A4_MIN, parseA4 } from '../components/format';
import type { ThemePref } from '../../state/theme';
import type { VoiceType } from '../../types';
import { MicrophoneSetting, StoragePanel } from '../components/StoragePanel';
import { TrainerSettings } from '../components/TrainerSettings';

const VOICE_TYPES = Object.keys(VOICE_TYPE_LABELS) as VoiceType[];
const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function SettingsPage() {
  const app = useApp();
  const trainer = useContext(TrainerContext);
  const { settings } = app.state;
  const ids = { voice: useId(), a4: useId(), key: useId(), model: useId() };
  const [a4Draft, setA4Draft] = useState(String(settings.a4Hz));
  const [a4Error, setA4Error] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState(settings.anthropicApiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState(settings.aiModel);
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const clearedRef = useRef<HTMLParagraphElement>(null);
  const clearButtonRef = useRef<HTMLButtonElement>(null);

  // The confirmation buttons disappear once used, so move focus to what replaces them: the
  // "All data cleared." status, or back to "Clear all data" after Cancel.
  useEffect(() => {
    if (cleared) clearedRef.current?.focus();
  }, [cleared]);
  const cancelClear = () => {
    setConfirmClear(false);
    requestAnimationFrame(() => clearButtonRef.current?.focus());
  };

  // Keep drafts in sync when settings change elsewhere (e.g. after clearing all data).
  useEffect(() => setA4Draft(String(settings.a4Hz)), [settings.a4Hz]);
  useEffect(() => setKeyDraft(settings.anthropicApiKey ?? ''), [settings.anthropicApiKey]);
  useEffect(() => setModelDraft(settings.aiModel), [settings.aiModel]);

  const zone = passaggioFor(settings.voiceType);
  const reanalysing = app.state.status !== 'idle' && app.state.progressLabel.startsWith('Re-analysing');

  const commitA4 = () => {
    const v = parseA4(a4Draft);
    if (v === null) {
      setA4Error(`Enter a frequency between ${A4_MIN} and ${A4_MAX} Hz.`);
      return;
    }
    setA4Error(null);
    setA4Draft(String(v));
    if (v !== settings.a4Hz) app.updateSettings({ a4Hz: v });
  };

  const saveKey = (e: FormEvent) => {
    e.preventDefault();
    const k = keyDraft.trim();
    app.updateSettings({ anthropicApiKey: k || null });
    setKeyNote(k ? 'Key saved in this browser.' : 'Key removed.');
  };

  const commitModel = () => {
    const m = modelDraft.trim() || DEFAULT_AI_MODEL;
    setModelDraft(m);
    if (m !== settings.aiModel) app.updateSettings({ aiModel: m });
  };

  const sessionsCount = app.state.sessions.length;

  return (
    <div className="page page--settings">
      <header className="page-head">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Set Mimic up for your voice</h1>
        <p className="lede">Everything here is stored only in this browser.</p>
      </header>

      <section className="settings-section" aria-labelledby="voice-heading">
        <h2 id="voice-heading" className="section-title">
          Your voice
        </h2>
        <div className="field">
          <label htmlFor={ids.voice} className="field-label">
            Voice type
          </label>
          <select
            id={ids.voice}
            className="select"
            value={settings.voiceType}
            onChange={(e) => app.updateSettings({ voiceType: e.currentTarget.value as VoiceType })}
          >
            {VOICE_TYPES.map((v) => (
              <option key={v} value={v}>
                {VOICE_TYPE_LABELS[v]}
              </option>
            ))}
          </select>
          <p className="field-hint">
            For a {VOICE_TYPE_NAMES[settings.voiceType].toLowerCase()}, the passaggio (the stretch where chest-dominant singing has to hand
            over to a lighter coordination) usually sits around{' '}
            <span className="num">
              {midiToNoteName(zone.lowMidi)}–{midiToNoteName(zone.highMidi)}
            </span>
            . Mimic treats notes from <span className="num">{midiToNoteName(zone.lowMidi)}</span> up as your upper range when it measures your
            mix. These are estimates of the mix zone in contemporary singing, a little higher than the classical passaggio points.
            Everyone’s passaggio is a little different; if unsure, pick the type whose zone matches where your voice starts to feel heavy or
            wants to flip.
          </p>
          {reanalysing && (
            <p className="field-hint" role="status">
              {app.state.job === 'reference' ? 'Re-analysing your reference clip' : 'Re-analysing your take'} with the new setting…
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor={ids.a4} className="field-label">
            Tuning reference (A4)
          </label>
          <div className="input-with-unit">
            <input
              id={ids.a4}
              className="text-input text-input--short num"
              type="number"
              inputMode="decimal"
              min={A4_MIN}
              max={A4_MAX}
              step={0.1}
              value={a4Draft}
              onChange={(e) => setA4Draft(e.currentTarget.value)}
              onBlur={commitA4}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitA4();
              }}
              aria-invalid={a4Error ? true : undefined}
              aria-describedby={`${ids.a4}-hint`}
            />
            <span className="unit">Hz</span>
          </div>
          <p id={`${ids.a4}-hint`} className={a4Error ? 'field-error' : 'field-hint'} role={a4Error ? 'alert' : undefined}>
            {a4Error ?? 'Leave at 440 unless you sing along to a track tuned differently (some recordings sit at 432 or 442).'}
          </p>
        </div>
        <MicrophoneSetting />
      </section>

      <section className="settings-section" aria-labelledby="ai-heading">
        <h2 id="ai-heading" className="section-title">
          AI coach (optional)
        </h2>
        <p className="settings-text">
          With your own Anthropic API key, the Results page can ask Claude to explain your analysis and answer follow-up questions. The key
          is sent only to Anthropic. Only the numbers from the analysis are sent, never your audio. Usage is billed to your Anthropic
          account.
        </p>
        <p className="settings-text">
          The key is saved in this site’s local storage in this browser, as plain text. On a <span className="num">github.io</span> address
          that storage is shared with the site owner’s other GitHub Pages sites, so use a key with a monthly spending limit (set one in the
          Anthropic Console) and remove it here when you no longer need it.
        </p>
        <form className="field" onSubmit={saveKey}>
          <label htmlFor={ids.key} className="field-label">
            Anthropic API key
          </label>
          <div className="input-row">
            <input
              id={ids.key}
              className="text-input num"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(e) => {
                setKeyDraft(e.currentTarget.value);
                setKeyNote(null);
              }}
            />
            <button type="button" className="button button--ghost button--small" onClick={() => setShowKey((s) => !s)} aria-pressed={showKey}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          <div className="button-row">
            <button type="submit" className="button button--accent button--small" disabled={keyDraft.trim() === (settings.anthropicApiKey ?? '')}>
              Save key
            </button>
            {settings.anthropicApiKey && (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  setKeyDraft('');
                  app.updateSettings({ anthropicApiKey: null });
                  setKeyNote('Key removed.');
                }}
              >
                Remove key
              </button>
            )}
          </div>
          <p className="field-hint" role="status">
            {keyNote ?? (settings.anthropicApiKey ? 'A key is saved.' : 'No key saved. Create one at console.anthropic.com.')}
          </p>
        </form>
        <div className="field">
          <label htmlFor={ids.model} className="field-label">
            Model
          </label>
          <div className="input-row">
            <input
              id={ids.model}
              className="text-input num"
              type="text"
              spellCheck={false}
              value={modelDraft}
              onChange={(e) => setModelDraft(e.currentTarget.value)}
              onBlur={commitModel}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitModel();
              }}
            />
            {settings.aiModel !== DEFAULT_AI_MODEL && (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  setModelDraft(DEFAULT_AI_MODEL);
                  app.updateSettings({ aiModel: DEFAULT_AI_MODEL });
                }}
              >
                Use default
              </button>
            )}
          </div>
          <p className="field-hint">
            Default: <span className="num">{DEFAULT_AI_MODEL}</span>.
          </p>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="look-heading">
        <h2 id="look-heading" className="section-title">
          Appearance
        </h2>
        <fieldset className="segmented">
          <legend className="field-label">Theme</legend>
          <div className="segmented-options">
            {THEMES.map((t) => (
              <label key={t.value} className="segmented-option">
                <input type="radio" name="theme" value={t.value} checked={app.theme === t.value} onChange={() => app.setTheme(t.value)} />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </section>

      <TrainerSettings />

      <StoragePanel />

      <section className="settings-section" aria-labelledby="data-heading">
        <h2 id="data-heading" className="section-title">
          Your data
        </h2>
        <p className="settings-text">
          Recordings of your takes are analysed on this device and are not stored: only the scores you save to Progress
          {sessionsCount ? (
            <>
              {' '}
              (<span className="num">{sessionsCount}</span> saved)
            </>
          ) : null}
          , your settings and your API key are kept, in this browser’s local storage. Clips you add to the Trainer, their phrases and practice scores are kept on this device too
          (see Trainer above).
        </p>
        {!confirmClear ? (
          <button
            ref={clearButtonRef}
            type="button"
            className="button button--danger"
            onClick={() => {
              setConfirmClear(true);
              setCleared(false);
            }}
          >
            Clear all data
          </button>
        ) : (
          <div className="confirm" role="group" aria-labelledby="confirm-text">
            <p id="confirm-text">
              Delete your saved progress, settings and API key from this browser, close the current take{trainer ? ', and delete every clip, phrase and practice score in the Trainer' : ''}? This cannot be undone.
            </p>
            <div className="button-row">
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  app.clearAllData();
                  // The Trainer's library is its own store; a failure here is reported on the Trainer section's own delete.
                  void trainer?.clearAll().catch(() => undefined);
                  setConfirmClear(false);
                  setCleared(true);
                }}
              >
                Yes, delete everything
              </button>
              <button type="button" className="button button--ghost" onClick={cancelClear} autoFocus>
                Cancel
              </button>
            </div>
          </div>
        )}
        <p ref={clearedRef} className="field-hint" role="status" tabIndex={-1}>
          {cleared ? 'All data cleared.' : ''}
        </p>
      </section>
    </div>
  );
}
