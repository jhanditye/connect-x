// Conversational feedback from Claude with the user's own key. Only the numeric summary built in
// coach/ai.ts is sent; the take's audio never leaves the browser.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AiCoachError, askAiCoach, type AiCoachInput } from '../../coach/ai';
import type { AppSettings } from '../../types';
import { Icon } from './Icon';
import { RichText } from './RichText';

type Turn = { role: 'user' | 'assistant'; text: string };

const FIRST_QUESTION = 'Give me feedback on this take and what to practise next.';

export function AiCoachPanel(props: {
  settings: AppSettings;
  input: Omit<AiCoachInput, 'question' | 'history'>;
  /** Changes whenever the take or target changes; the conversation restarts. */
  conversationKey: string;
  onOpenSettings: () => void;
  singerName: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputId = useId();

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setStreaming(null);
    setError(null);
    setDraft('');
  }, [props.conversationKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = streaming !== null;
  const hasKey = !!props.settings.anthropicApiKey?.trim();

  async function ask(question: string) {
    if (busy || !question.trim()) return;
    const history = turns;
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setTurns([...history, { role: 'user', text: question }]);
    setStreaming('');
    let partial = '';
    try {
      const answer = await askAiCoach(
        { ...props.input, question, history },
        props.settings,
        (delta) => {
          partial += delta;
          setStreaming(partial);
        },
        controller.signal,
      );
      if (abortRef.current !== controller) return;
      setTurns([...history, { role: 'user', text: question }, { role: 'assistant', text: answer || partial }]);
    } catch (err) {
      // Superseded by a reset (new take or singer): drop the reply.
      if (abortRef.current !== controller) return;
      if (controller.signal.aborted && partial.trim()) {
        // Keep what arrived before Stop so the conversation still alternates user/assistant.
        setTurns([...history, { role: 'user', text: question }, { role: 'assistant', text: `${partial.trim()}\n\n*(stopped)*` }]);
      } else {
        setTurns(history);
        if (!controller.signal.aborted) {
          setError(err instanceof AiCoachError || err instanceof Error ? err.message : 'The AI coach could not answer.');
        }
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(null);
      }
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    void ask(q);
  };

  if (!hasKey) {
    return (
      <p className="ai-nokey">
        Want this explained like a coach would? Add your Anthropic API key in{' '}
        <button type="button" className="link-button" onClick={props.onOpenSettings}>
          Settings
        </button>{' '}
        to ask Claude about this take. Only the numbers are sent, never your audio.
      </p>
    );
  }

  return (
    <div className="ai-panel">
      {turns.length === 0 && !busy && (
        <div className="ai-start">
          <p className="muted">
            Claude reads the numbers from this take and the {props.singerName} comparison (never the audio) and talks you through them.
          </p>
          <button type="button" className="button button--accent" onClick={() => void ask(FIRST_QUESTION)}>
            <Icon name="spark" size={18} /> Ask the AI coach
          </button>
        </div>
      )}

      {turns.length > 0 && (
        <ol className="ai-thread" aria-label="Conversation with the AI coach">
          {turns.map((t, i) => (
            <li key={i} className={`ai-turn ai-turn--${t.role}`}>
              <span className="ai-turn-who">{t.role === 'user' ? 'You' : 'Coach'}</span>
              {t.role === 'user' ? <p>{t.text}</p> : <RichText text={t.text} />}
            </li>
          ))}
          {busy && (
            <li className="ai-turn ai-turn--assistant" aria-live="polite" aria-busy="true">
              <span className="ai-turn-who">Coach</span>
              {streaming ? <RichText text={streaming} /> : <p className="muted">Thinking…</p>}
            </li>
          )}
        </ol>
      )}

      {error && (
        <p className="ai-error" role="alert">
          {error}
        </p>
      )}

      {busy ? (
        <button type="button" className="button button--ghost" onClick={() => abortRef.current?.abort()}>
          <Icon name="stop" size={16} /> Stop
        </button>
      ) : (
        turns.length > 0 && (
          <form className="ai-followup" onSubmit={onSubmit}>
            <label htmlFor={inputId} className="visually-hidden">
              Ask a follow-up question
            </label>
            <input
              id={inputId}
              className="text-input"
              type="text"
              value={draft}
              placeholder="Ask a follow-up, e.g. how do I keep the top note light?"
              onChange={(e) => setDraft(e.currentTarget.value)}
              maxLength={600}
            />
            <button type="submit" className="button button--accent" disabled={!draft.trim()}>
              Ask
            </button>
          </form>
        )
      )}
    </div>
  );
}
