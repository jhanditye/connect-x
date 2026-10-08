// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContext, type AppController } from '../../state/context';
import { createInitialState } from '../../state/reducer';
import { GuidePage } from './Guide';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const app = {
    state: createInitialState({ voiceType: 'baritone', a4Hz: 440, anthropicApiKey: null, aiModel: 'claude-opus-5' }, [], []),
  } as unknown as AppController;
  act(() =>
    root.render(
      <AppContext.Provider value={app}>
        <GuidePage />
      </AppContext.Provider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('GuidePage', () => {
  it('the table of contents moves keyboard focus to the chosen section heading', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const toc = Array.from(container.querySelectorAll('.guide-toc button')).find((b) => b.textContent === 'Look after your voice') as HTMLButtonElement;
    act(() => toc.click());
    expect(document.activeElement?.id).toBe('guide-health-h');
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
  });

  it('covers the safety, measurement and privacy caveats', () => {
    const text = container.textContent ?? '';
    expect(text).toMatch(/suddenly cuts out.*stop singing straight away/);
    expect(text).toMatch(/more than two weeks.*laryngologist/);
    expect(text).toMatch(/Falsetto and head voice/);
    expect(text).toMatch(/most reliable on open vowels/);
    expect(text).toMatch(/Compare your progress on the same device/);
    expect(text).toMatch(/contemporary pop and R&B singing.*higher\s+than the classical passaggio/);
    expect(text).toMatch(/fonts are bundled/);
    expect(text).toMatch(/github\.io/);
    // Plain voice-type names in the table, no nested parentheses.
    expect(text).not.toContain('))');
    expect(text).toContain('Baritone (yours)');
  });

  it('has a table of contents entry and a heading for each Trainer section', () => {
    const toc = Array.from(container.querySelectorAll('.guide-toc button')).map((b) => b.textContent);
    for (const title of [
      'Getting a vocal onto your phone',
      'Full songs and vocal stems',
      'Sing along, or listen then sing',
      'Headphones and AirPods',
      'What the Trainer scores, and what it cannot hear',
    ]) {
      expect(toc).toContain(title);
    }
    for (const id of ['guide-vocal', 'guide-stems', 'guide-modes', 'guide-headphones', 'guide-trainer-scores']) {
      const section = container.querySelector(`#${id}`);
      expect(section?.querySelector('h2')?.id).toBe(`${id}-h`);
      expect(section?.querySelector('h2')?.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('says how to get a vocal onto the phone: Files, Voice Memos, DRM-free music, stems, video, and why not the Share sheet', () => {
    const text = container.querySelector('#guide-vocal')?.textContent ?? '';
    expect(text).toMatch(/The Files app/);
    expect(text).toMatch(/Voice Memos.*Share, then Save to Files/s);
    expect(text).toMatch(/without copy protection/);
    expect(text).toMatch(/Apple Music/);
    expect(text).toMatch(/Vocal stems/);
    expect(text).toMatch(/Encode Media/);
    expect(text).toMatch(/Share sheet/);
    expect(text).toMatch(/never downloads music/);
  });

  it('explains full songs against vocal stems, with what is and is not measured', () => {
    const text = container.querySelector('#guide-stems')?.textContent ?? '';
    expect(text).toMatch(/isolated vocal.*best material/s);
    expect(text).toMatch(/does not.*compare tone for a full\s+song/s);
    expect(text).toMatch(/play the detected melody/);
    expect(text).toMatch(/cannot count toward a singer’s measured targets/);
  });

  it('explains pulling the vocal out of a song: what it costs, what it cannot do, where the model comes from, and carries the Spleeter MIT notice', () => {
    const toc = Array.from(container.querySelectorAll('.guide-toc button')).map((b) => b.textContent);
    expect(toc).toContain('Pulling the vocal out of a song (AI)');
    const text = container.querySelector('#guide-isolate')?.textContent ?? '';
    expect(text).toMatch(/off unless you choose it/);
    expect(text).toMatch(/about 31 MB/);
    expect(text).toMatch(/the model, about 19 MB, and the engine that runs it, about 11 MB/);
    expect(text).not.toMatch(/just like a real a cappella/);
    expect(text).toMatch(/not the real thing/);
    expect(text).toMatch(/minutes, not seconds/);
    expect(text).toMatch(/battery/);
    expect(text).toMatch(/approximate/);
    expect(text).toMatch(/rough estimates/);
    expect(text).toMatch(/Isolated vocal \(AI\)/);
    expect(text).toMatch(/song never leaves the phone/);
    expect(text).toMatch(/Spleeter/);
    expect(text).toMatch(/MIT License/);
    expect(text).toMatch(/Copyright \(c\) 2019-present, Deezer SA\./);
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).toMatch(/no separate licence|without a separate licence/);
    expect(container.querySelector('#privacy, #guide-privacy')?.textContent).toMatch(/Pulling a vocal out of a song/);
  });

  it('explains sing along against listen then sing, and why sing along needs headphones', () => {
    const text = container.querySelector('#guide-modes')?.textContent ?? '';
    expect(text).toMatch(/Sing along.*headphones/s);
    expect(text).toMatch(/Listen, then sing.*your own pace/s);
    expect(text).toMatch(/three good tries at full speed/);
    expect(text).toMatch(/50 percent sounds rough/);
  });

  it('covers headphones and AirPods: Bluetooth call mode, the iPhone microphone, the sync offset, the silent switch', () => {
    const text = container.querySelector('#guide-headphones')?.textContent ?? '';
    expect(text).toMatch(/AirPods and other Bluetooth headphones/);
    expect(text).toMatch(/phone-call quality/);
    expect(text).toMatch(/iPhone.s own microphone/);
    expect(text).toMatch(/sync offset.*not counted against you/s);
    expect(text).toMatch(/silent switch/);
  });

  it('is honest about what the Trainer scores and what it cannot hear', () => {
    const text = container.querySelector('#guide-trainer-scores')?.textContent ?? '';
    expect(text).toMatch(/pitch.*40 percent.*timing.*25.*tone.*20.*expression.*15/s);
    expect(text).toMatch(/in Listen then sing any key is fine; while singing along only octaves count/);
    expect(text).not.toMatch(/any key or octave is fine/);
    expect(text).toMatch(/closeness, not quality/);
    expect(text).toMatch(/not on ratings by people/);
    expect(text).toMatch(/words and diction/);
    expect(text).toMatch(/pitch-corrected/);
    expect(text).toMatch(/never ask for more volume or for rasp/);
  });

  it('privacy says clips and attempts stay on this device, and that takes are not kept unless asked', () => {
    const text = container.querySelector('#guide-privacy')?.textContent ?? '';
    expect(text).toMatch(/Clips and attempts stay on this device/);
    expect(text).toMatch(/never audio/);
    expect(text).toMatch(/Keep my recordings/);
    expect(text).toMatch(/Home Screen/);
    expect(text).toMatch(/Trainer.s clips and scores/);
  });
});
