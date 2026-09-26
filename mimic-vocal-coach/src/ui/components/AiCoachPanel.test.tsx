// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCoachError, askAiCoach } from '../../coach/ai';
import { makeFakeAnalysis, makeFakeComparison, makeFakePlan, makeFakeProfile } from '../../testing/fixtures';
import type { AppSettings } from '../../types';
import { AiCoachPanel, type Turn } from './AiCoachPanel';

vi.mock('../../coach/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../coach/ai')>();
  return { ...actual, askAiCoach: vi.fn() };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: 'sk-ant-test', aiModel: 'claude-opus-5' };
const INPUT = { analysis: makeFakeAnalysis(), comparison: makeFakeComparison(), plan: makeFakePlan(), profile: makeFakeProfile() };

let container: HTMLDivElement;
let root: Root;
let stored: { key: string; turns: Turn[] }[];

/** The panel with its conversation held by a parent, like Results does with app state. */
function Host(props: { conversationKey?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  return (
    <AiCoachPanel
      settings={SETTINGS}
      input={INPUT}
      conversationKey={props.conversationKey ?? 'k1'}
      turns={turns}
      onTurns={(key, t) => {
        stored.push({ key, turns: t });
        setTurns(t);
      }}
      onOpenSettings={() => undefined}
      singerName="Test"
    />
  );
}

function button(re: RegExp): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find((el) => re.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button matching ${re}`);
  return b;
}

beforeEach(() => {
  stored = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(askAiCoach).mockReset();
});

describe('AiCoachPanel', () => {
  it('keeps keyboard focus on Stop while answering, then on the follow-up field', async () => {
    let finish: (text: string) => void = () => undefined;
    vi.mocked(askAiCoach).mockImplementation(
      (_input, _settings, onText) =>
        new Promise<string>((resolve) => {
          onText('Partial');
          finish = resolve;
        }),
    );
    act(() => root.render(<Host />));
    await act(async () => button(/Ask the AI coach/).click());
    expect(document.activeElement?.textContent).toMatch(/Stop/);
    await act(async () => finish('Full answer.'));
    expect(document.activeElement).toBe(container.querySelector('.ai-followup input'));
    expect(stored[stored.length - 1].turns.map((t) => t.text)).toContain('Full answer.');
  });

  it('when the first question fails, shows the error and puts focus back on the Ask button (not the page body)', async () => {
    vi.mocked(askAiCoach).mockRejectedValue(new AiCoachError('auth', 'The API key was rejected. Check the key in Settings.'));
    act(() => root.render(<Host />));
    await act(async () => button(/Ask the AI coach/).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/API key was rejected/);
    expect(document.activeElement).toBe(button(/Ask the AI coach/));
    expect(stored[stored.length - 1].turns).toEqual([]);
  });

  it('Stop before any text arrives puts focus back on the Ask button', async () => {
    vi.mocked(askAiCoach).mockImplementation(
      (_input, _settings, _onText, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    act(() => root.render(<Host />));
    await act(async () => button(/Ask the AI coach/).click());
    expect(document.activeElement?.textContent).toMatch(/Stop/);
    await act(async () => button(/Stop/).click());
    expect(document.activeElement).toBe(button(/Ask the AI coach/));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a failed follow-up keeps focus on the follow-up field', async () => {
    vi.mocked(askAiCoach).mockResolvedValueOnce('First answer.').mockRejectedValueOnce(new AiCoachError('network', 'Could not reach Claude.'));
    act(() => root.render(<Host />));
    await act(async () => button(/Ask the AI coach/).click());
    const field = container.querySelector<HTMLInputElement>('.ai-followup input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'And the top note?');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button(/^Ask$/).click());
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/Could not reach Claude/);
    expect(document.activeElement).toBe(container.querySelector('.ai-followup input'));
  });

  it('leaving mid-answer stores what arrived, marked as stopped, under the key it was asked for', async () => {
    vi.mocked(askAiCoach).mockImplementation(
      (_input, _settings, onText, signal) =>
        new Promise<string>((_resolve, reject) => {
          onText('Half an answer');
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    act(() => root.render(<Host />));
    await act(async () => button(/Ask the AI coach/).click());
    await act(async () => root.unmount());
    root = createRoot(container);
    const last = stored[stored.length - 1];
    expect(last.key).toBe('k1');
    expect(last.turns).toHaveLength(2);
    expect(last.turns[1].text).toContain('Half an answer');
    expect(last.turns[1].text).toContain('(stopped)');
  });
});
