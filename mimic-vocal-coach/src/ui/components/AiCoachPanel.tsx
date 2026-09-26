// Conversational feedback from Claude with the user's own key. Only the numeric summary built in
// coach/ai.ts is sent; the take's audio never leaves the browser.
//
// The conversation itself lives in app state (the parent passes `turns` and `onTurns`), so leaving
// Results, e.g. to follow a coaching card's exercise link, does not throw away answers the user paid
// for. Only the in-flight stream belongs to this component.

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AiCoachError, askAiCoach, type AiCoachInput } from '../../coach/ai';
import type { AppSettings } from '../../types';
import { Icon } from './Icon';
import { RichText } from './RichText';

export type Turn = { role: 'user' | 'assistant'; text: string };

const FIRST_QUESTION = 'Give me feedback on this take and what to practise next.';

export function AiCoachPanel(props: {
  settings: AppSettings;
  input: Omit<AiCoachInput, 'question' | 'history'>;
  /** Changes whenever the take or target changes; an answer still streaming for the old key is dropped. */
  conversationKey: string;
  /** The conversation so far for this key. */
  turns: Turn[];
  /** Stores the conversation for `key` (the key it was asked under, even if the page has moved on). */
  onTurns: (key: string, turns: Turn[]) => void;
  onOpenSettings: () => void;
  singerName: string;
}) {
  const { turns, onTurns } = props;
  const [streaming, setStreaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputId = useId();
  const stopRef = useRef<HTMLButtonElement>(null);
  const followupRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(null);
    setError(null);
    setDraft('');
  }, [props.conversationKey]);

  // Leaving the page stops the stream; ask() then stores whatever had arrived, marked as stopped.
  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = streaming !== null;
  const hasKey = !!props.settings.anthropicApiKey?.trim();

  // The button that was pressed disappears while Claude answers, so keep keyboard focus on the
  // controls that replace it: Stop while streaming, then the follow-up field, or the Ask button again
  // when the first question failed or was stopped before any answer (there is no conversation yet).
  // A layout effect, so focus moves in the same commit that removes the pressed button.
  useLayoutEffect(() => {
    if (busy && !wasBusy.current) stopRef.current?.focus();
    if (!busy && wasBusy.current) (followupRef.current ?? askRef.current)?.focus();
    wasBusy.current = busy;
  }, [busy]);

  async function ask(question: string) {
    if (busy || !question.trim()) return;
    const history = turns;
    const key = props.conversationKey;
    const setTurns = (t: Turn[]) => onTurns(key, t);
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
      // Stored under the key it was asked for, even if the singer changed meanwhile.
      setTurns([...history, { role: 'user', text: question }, { role: 'assistant', text: answer || partial }]);
    } catch (err) {
      // Superseded (the singer changed mid-answer): drop the reply and the unanswered question.
      if (abortRef.current !== controller) {
        setTurns(history);
        return;
      }
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
          <button ref={askRef} type="button" className="button button--accent" onClick={() => void ask(FIRST_QUESTION)}>
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
        <button ref={stopRef} type="button" className="button button--ghost" onClick={() => abortRef.current?.abort()}>
          <Icon name="stop" size={16} /> Stop
        </button>
      ) : (
        turns.length > 0 && (
          <form className="ai-followup" onSubmit={onSubmit}>
            <label htmlFor={inputId} className="visually-hidden">
              Ask a follow-up question
            </label>
            <input
              ref={followupRef}
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
