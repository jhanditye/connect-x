import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  makeFakeAnalysis,
  makeFakeComparison,
  makeFakeProfile,
  makeFakeReferenceComparison,
  makeFakeSessions,
} from '../../testing/fixtures';
import type { DimensionResult, SessionRecord } from '../../types';
import { formatDimValue, niceTicks, singerVar, timeTicks, formatTick, fmtSigned } from './chartKit';
import { DimensionMeter, meterDomain } from './DimensionMeter';
import { contourSegments, pitchYDomain, PitchPlot, refTimeMapper } from './PitchPlot';
import { labelIndices, ProgressChart, progressPoints } from './ProgressChart';
import { isBlackKey, keyboardLayout, RangeKeyboard } from './RangeKeyboard';
import { centsExtent, decimateRun, diffRuns, ReferenceDiffPlot } from './ReferenceDiffPlot';
import { normaliseShares, RegisterBar } from './RegisterBar';
import { ScoreDial } from './ScoreDial';
import { BAND_IN, BAND_OUT, placeRadarLabels, radarRadius, StyleRadar } from './StyleRadar';

function ariaLabels(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
}

function imgLabel(html: string): string {
  const m = /role="img"[^>]*aria-label="([^"]*)"|aria-label="([^"]*)"[^>]*role="img"/.exec(html);
  return (m?.[1] ?? m?.[2] ?? '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
}

describe('chart rendering (server markup)', () => {
  it('PitchPlot renders the contour, passaggio band and a descriptive label', () => {
    const html = renderToStaticMarkup(<PitchPlot analysis={makeFakeAnalysis()} />);
    const label = imgLabel(html);
    expect(label).toContain('Pitch over 12.0 seconds');
    expect(label).toContain('range G3 to A4');
    expect(label).toContain('passaggio D4 to G4');
    expect(label).toContain('60% chest, 25% mix, 15% head');
    expect(html).toContain('passaggio');
    expect(html).toContain('var(--reg-chest)');
    expect(html).toContain('var(--reg-mix)');
    expect(html).toContain('var(--reg-head)');
    // Note labels on the axis.
    expect(html).toMatch(/>C4</);
    expect(html).toMatch(/>G3</);
    // Time ticks.
    expect(html).toMatch(/>0s</);
    expect(html).not.toContain('NaN');
  });

  it('PitchPlot overlays a shifted reference mapped through the DTW path', () => {
    const user = makeFakeAnalysis();
    const ref = makeFakeAnalysis();
    const html = renderToStaticMarkup(
      <PitchPlot analysis={user} reference={ref} referenceShiftSemitones={-12} referencePath={makeFakeReferenceComparison().path} />,
    );
    expect(imgLabel(html)).toContain('shifted down 12 semitones');
    expect(html).toContain('stroke-dasharray:4 3');
    expect(html).toContain('Reference');
    expect(html).not.toContain('NaN');
  });

  it('PitchPlot copes with a take that has no voiced frames and with showRegisters=false', () => {
    const a = makeFakeAnalysis();
    const silent = {
      ...a,
      frames: a.frames.map((f) => ({ ...f, voiced: false, midi: NaN, f0: NaN, register: null })),
      notes: [],
      pitch: { ...a.pitch, lowMidi: null, highMidi: null, medianMidi: null, tessituraLowMidi: null, tessituraHighMidi: null },
    };
    const html = renderToStaticMarkup(<PitchPlot analysis={silent} showRegisters={false} height={200} />);
    expect(imgLabel(html)).toContain('no clear pitch detected');
    expect(html).not.toContain('NaN');
  });

  it('PitchPlot scrolls sideways for takes longer than a minute', () => {
    const a = makeFakeAnalysis();
    const long = { ...a, durationSec: 90 };
    const html = renderToStaticMarkup(<PitchPlot analysis={long} />);
    expect(html).toContain('pitchplot-scroll--on');
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/>1:00</);
  });

  it('StyleRadar renders spokes for measured dimensions only', () => {
    const comparison = makeFakeComparison();
    comparison.dimensions.push(
      {
        key: 'brightness',
        label: 'Brightness',
        value: 0.8,
        target: { ideal: 0.6, low: 0.5, high: 0.7, tolerance: 0.3, weight: 0.6 },
        score: 70,
        direction: 'less',
        summary: 'Brighter than the target.',
      },
      {
        key: 'vibratoRateHz',
        label: 'Vibrato rate',
        value: null,
        target: { ideal: 5.5, low: 5, high: 6, tolerance: 1.5, weight: 0.3 },
        score: 50,
        direction: 'unknown',
        summary: 'Not measured.',
      },
    );
    const html = renderToStaticMarkup(<StyleRadar comparison={comparison} profile={makeFakeProfile()} />);
    const label = imgLabel(html);
    expect(label).toContain('Test Singer');
    expect(label).toContain('overall 68');
    expect(label).toContain('3 measures');
    expect(label).not.toContain('Vibrato rate');
    expect(html).toContain('<polygon');
    // Custom profile colour (not a builtin singer id) is used as-is.
    expect(html).toContain('#50606f');
  });

  it('StyleRadar uses the theme variable for builtin singers and handles no measures', () => {
    const comparison = { ...makeFakeComparison('daniel-caesar'), dimensions: [] as DimensionResult[] };
    const html = renderToStaticMarkup(<StyleRadar comparison={comparison} profile={makeFakeProfile({ id: 'daniel-caesar', name: 'Daniel Caesar' })} size={240} />);
    expect(html).toContain('var(--singer-daniel)');
    expect(imgLabel(html)).toContain('no style measures');
  });

  it('RangeKeyboard marks both ranges and the passaggio', () => {
    const html = renderToStaticMarkup(
      <RangeKeyboard
        userLow={55}
        userHigh={69}
        userTessitura={[59, 65]}
        singerRange={{ lowMidi: 50, highMidi: 74, tessituraLowMidi: 57, tessituraHighMidi: 67 }}
        singerColor="var(--singer-shawn)"
        passaggio={{ lowMidi: 62, highMidi: 67 }}
      />,
    );
    const label = imgLabel(html);
    expect(label).toContain('your range G3–A4, mostly B3–F4');
    expect(label).toContain('singer range D3–D5');
    expect(label).toContain('passaggio D4–G4');
    expect(html).toContain('var(--singer-shawn)');
    expect(html).toMatch(/>C4</);
    expect(html).toContain('rangekb-black');
  });

  it('RangeKeyboard explains a missing range', () => {
    const html = renderToStaticMarkup(<RangeKeyboard userLow={null} userHigh={null} />);
    expect(imgLabel(html)).toContain('your range was not measured');
    expect(html).toContain('Not enough steady singing');
  });

  it('RegisterBar labels segments and hides labels under 8%', () => {
    const html = renderToStaticMarkup(<RegisterBar chest={0.6} mix={0.35} head={0.05} target={{ chest: 0.2, mix: 0.5, head: 0.3 }} />);
    expect(imgLabel(html)).toBe('Estimated register shares. You: 60% chest, 35% mix, 5% head. Target: 20% chest, 50% mix, 30% head.');
    expect(html).toContain('>60%<');
    expect(html).toContain('>35%<');
    expect(html).not.toContain('>5%<');
    expect(html).toContain('>Target<');
  });

  it('RegisterBar shows an empty track when there is no data', () => {
    const html = renderToStaticMarkup(<RegisterBar chest={0} mix={0} head={0} label="Upper range" />);
    expect(html).toContain('No data');
    expect(imgLabel(html)).toContain('Upper range: 0% chest');
  });

  it('ScoreDial shows the rounded, clamped score', () => {
    const html = renderToStaticMarkup(<ScoreDial score={67.6} label="Match with Shawn" color="var(--singer-shawn)" />);
    expect(imgLabel(html)).toBe('Match with Shawn: 68 out of 100');
    expect(html).toContain('>68<');
    expect(html).toContain('var(--singer-shawn)');
    expect(imgLabel(renderToStaticMarkup(<ScoreDial score={140} />))).toBe('Score: 100 out of 100');
    expect(imgLabel(renderToStaticMarkup(<ScoreDial score={NaN} />))).toBe('Score: not available');
  });

  it('DimensionMeter shows value with units, band and score tone', () => {
    const [breath, mix] = makeFakeComparison().dimensions;
    const b = renderToStaticMarkup(<DimensionMeter result={breath} />);
    expect(imgLabel(b)).toBe('Breathiness: 0.42; target 0.40–0.60, ideal 0.50; score 84 of 100.');
    expect(b).toContain('meter-chip--good');
    expect(b).toContain('Close to the target airiness');
    const m = renderToStaticMarkup(<DimensionMeter result={mix} />);
    expect(m).toContain('>30%<');
    expect(m).toContain('meter-chip--bad');
    const missing = renderToStaticMarkup(<DimensionMeter result={{ ...breath, value: null }} />);
    expect(missing).toContain('not measured');
    expect(imgLabel(missing)).toContain('not measured in this take');
  });

  it('DimensionMeter warns in the 60-79 range and formats units per dimension', () => {
    const r: DimensionResult = {
      key: 'vibratoRateHz',
      label: 'Vibrato rate',
      value: 6.84,
      target: { ideal: 5.5, low: 5, high: 6, tolerance: 1.5, weight: 0.5 },
      score: 65,
      direction: 'less',
      summary: 'A little fast.',
    };
    const html = renderToStaticMarkup(<DimensionMeter result={r} />);
    expect(html).toContain('6.8 Hz');
    expect(html).toContain('meter-chip--warn');
  });

  it('ProgressChart plots the chosen metric for one profile, with an empty state', () => {
    const sessions = makeFakeSessions(6);
    const html = renderToStaticMarkup(<ProgressChart sessions={sessions} profileId="test-singer" />);
    const label = imgLabel(html);
    expect(label).toContain('Overall match over 6 sessions');
    expect(label).toContain('from 55');
    expect(label).toContain('to 75');
    expect(html).toContain('>75<');
    const mix = renderToStaticMarkup(<ProgressChart sessions={sessions} profileId="test-singer" metric="mixInUpperRange" />);
    expect(imgLabel(mix)).toContain('Mix above the passaggio score over 6 sessions: from 40');
    const empty = renderToStaticMarkup(<ProgressChart sessions={sessions} profileId="someone-else" />);
    expect(empty).toContain('No saved takes yet');
    const one = renderToStaticMarkup(<ProgressChart sessions={sessions.slice(0, 1)} />);
    expect(imgLabel(one)).toContain('one session, 55');
  });

  it('ReferenceDiffPlot draws the cents line with the ±50 band', () => {
    const html = renderToStaticMarkup(<ReferenceDiffPlot comparison={makeFakeReferenceComparison()} />);
    const label = imgLabel(html);
    expect(label).toContain('82% of aligned frames within 50 cents');
    expect(label).toContain('average 22 cents');
    expect(label).toContain('12 semitones lower');
    expect(html).toContain('+50¢');
    expect(html).toContain('var(--accent-soft)');
    const empty = renderToStaticMarkup(<ReferenceDiffPlot comparison={{ ...makeFakeReferenceComparison(), path: [] }} />);
    expect(empty).toContain('No aligned singing');
  });

  it('every chart exposes an aria-label', () => {
    const a = makeFakeAnalysis();
    const charts = [
      <PitchPlot key="p" analysis={a} />,
      <StyleRadar key="s" comparison={makeFakeComparison()} profile={makeFakeProfile()} />,
      <RangeKeyboard key="r" userLow={55} userHigh={69} />,
      <RegisterBar key="b" chest={0.5} mix={0.3} head={0.2} />,
      <ScoreDial key="d" score={50} />,
      <DimensionMeter key="m" result={makeFakeComparison().dimensions[0]} />,
      <ProgressChart key="c" sessions={makeFakeSessions()} />,
      <ReferenceDiffPlot key="f" comparison={makeFakeReferenceComparison()} />,
    ];
    for (const c of charts) {
      const html = renderToStaticMarkup(c);
      expect(html).toContain('role="img"');
      expect(ariaLabels(html).some((l) => l.length > 10)).toBe(true);
    }
  });
});

describe('PitchPlot helpers', () => {
  const f = (t: number, midi: number, register: 'chest' | 'mix' | 'head' | null = 'chest') => ({ t, midi, register });

  it('breaks the contour at unvoiced frames and register changes, sharing the boundary point', () => {
    const frames = [f(0, 60), f(0.01, 60.1), f(0.02, NaN, null), f(0.03, 62), f(0.04, 62.2, 'mix'), f(0.05, 62.3, 'mix')];
    const segs = contourSegments(frames, 1, true);
    expect(segs.map((s) => s.register)).toEqual(['chest', 'chest', 'mix']);
    expect(segs[0].points.map((p) => p.t)).toEqual([0, 0.01]);
    expect(segs[1].points.map((p) => p.t)).toEqual([0.03, 0.04]);
    expect(segs[2].points.map((p) => p.t)).toEqual([0.04, 0.05]);
    // Without register colouring, only the gap splits it.
    expect(contourSegments(frames, 1, false)).toHaveLength(2);
  });

  it('decimates to every stride-th point but keeps run ends', () => {
    const frames = Array.from({ length: 101 }, (_, i) => f(i * 0.01, 60 + i / 100));
    const segs = contourSegments(frames, 10, true);
    expect(segs).toHaveLength(1);
    expect(segs[0].points).toHaveLength(11);
    expect(segs[0].points[10].t).toBeCloseTo(1);
    const odd = contourSegments(frames.slice(0, 95), 10, true);
    expect(odd[0].points[odd[0].points.length - 1].t).toBeCloseTo(0.94);
  });

  it('fits the y range to the data with 2 semitones of padding and at least an octave', () => {
    expect(pitchYDomain([55, 69])).toEqual([53, 71]);
    const [lo, hi] = pitchYDomain([60, 61]);
    expect(hi - lo).toBe(12);
    expect(lo).toBeLessThanOrEqual(58);
    expect(hi).toBeGreaterThanOrEqual(63);
    expect(pitchYDomain([], { lowMidi: 62, highMidi: 67 })).toEqual([56, 73]);
  });

  it('maps reference time to user time along the DTW path', () => {
    const map = refTimeMapper([
      { userT: 0, refT: 1, centsDiff: 0 },
      { userT: 2, refT: 2, centsDiff: 0 },
      { userT: 4, refT: 4, centsDiff: 0 },
    ]);
    expect(map(1)).toBe(0);
    expect(map(1.5)).toBe(1);
    expect(map(3)).toBe(3);
    expect(map(0.5)).toBeNull();
    expect(map(5)).toBeNull();
    expect(refTimeMapper([])(1)).toBeNull();
  });
});

describe('other chart helpers', () => {
  it('radar normalisation maps the band to the ring and tolerance to centre/rim', () => {
    const band = { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.3, weight: 1 };
    expect(radarRadius(0.4, band)).toBeCloseTo(BAND_IN);
    expect(radarRadius(0.6, band)).toBeCloseTo(BAND_OUT);
    expect(radarRadius(0.5, band)).toBeCloseTo((BAND_IN + BAND_OUT) / 2);
    expect(radarRadius(0.1, band)).toBeCloseTo(0);
    expect(radarRadius(-5, band)).toBe(0);
    expect(radarRadius(0.9, band)).toBeCloseTo(1);
    expect(radarRadius(50, band)).toBe(1);
    expect(radarRadius(0.25, band)).toBeCloseTo(BAND_IN / 2);
  });

  it('radar labels never overlap and stay inside the width, even when crowded', () => {
    for (const [n, width] of [
      [3, 288],
      [8, 288],
      [15, 288],
      [15, 440],
    ]) {
      const R = Math.min(120, width / 2 - 70);
      const labels = Array.from({ length: n }, (_, i) => ({ angle: -Math.PI / 2 + (i / n) * 2 * Math.PI, width: 66 }));
      const placed = placeRadarLabels(labels, width / 2, 30 + R, R, width);
      for (let i = 0; i < placed.length; i++) {
        const a = placed[i].box;
        expect(a[0]).toBeGreaterThanOrEqual(0);
        expect(a[2]).toBeLessThanOrEqual(width);
        for (let j = 0; j < i; j++) {
          const b = placed[j].box;
          const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
          expect(overlap, `n=${n} w=${width}: labels ${j} and ${i} overlap`).toBe(false);
        }
      }
    }
  });

  it('keyboard layout starts and ends on white keys and centres black keys on boundaries', () => {
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
    const k = keyboardLayout(61, 72, 700);
    expect(k.from).toBe(60);
    expect(k.to).toBe(72);
    const whites = k.keys.filter((x) => !x.black);
    expect(whites).toHaveLength(8);
    expect(k.whiteW).toBeCloseTo(700 / 8);
    expect(k.centre(60)).toBeCloseTo(k.whiteW / 2);
    expect(k.centre(61)).toBeCloseTo(k.whiteW);
    expect(k.centre(30)).toBe(k.centre(60));
    expect(k.keys.filter((x) => x.black)).toHaveLength(5);
  });

  it('register shares are normalised and cleaned', () => {
    expect(normaliseShares({ chest: 2, mix: 1, head: 1 })).toEqual({ chest: 0.5, mix: 0.25, head: 0.25 });
    expect(normaliseShares({ chest: -1, mix: NaN, head: 1 })).toEqual({ chest: 0, mix: 0, head: 1 });
  });

  it('meter domain is band ± tolerance within physical bounds', () => {
    expect(meterDomain('breathiness', { ideal: 0.5, low: 0.4, high: 0.6, tolerance: 0.3, weight: 1 })).toEqual([0.1, 0.9].map((v) => expect.closeTo(v, 9)));
    expect(meterDomain('mixInUpperRange', { ideal: 0.8, low: 0.7, high: 0.9, tolerance: 0.4, weight: 1 })).toEqual([expect.closeTo(0.3, 9), 1]);
    expect(meterDomain('pitchAccuracyCents', { ideal: 5, low: 0, high: 15, tolerance: 25, weight: 1 })).toEqual([0, 40]);
    expect(meterDomain('loudnessClimbDbPerSemitone', { ideal: 0.3, low: 0, high: 0.6, tolerance: 1, weight: 1 })).toEqual([-1, 1.6]);
  });

  it('formats dimension values with their units', () => {
    expect(formatDimValue('mixInUpperRange', 0.304)).toBe('30%');
    expect(formatDimValue('vibratoRateHz', 5.44)).toBe('5.4 Hz');
    expect(formatDimValue('pitchAccuracyCents', 18.4)).toBe('18¢');
    expect(formatDimValue('vibratoExtentCents', 45.2)).toBe('±45¢');
    expect(formatDimValue('dynamicRangeDb', 14)).toBe('14.0 dB');
    expect(formatDimValue('loudnessClimbDbPerSemitone', -0.25)).toBe('−0.3 dB/semitone');
    expect(formatDimValue('loudnessClimbDbPerSemitone', 1.1)).toBe('+1.1 dB/semitone');
    expect(formatDimValue('breathiness', 0.4)).toBe('0.40');
    expect(formatDimValue('agility', null)).toBe('–');
    expect(fmtSigned(0.04, 1)).toBe('0.0');
  });

  it('ticks and colours', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(timeTicks(12, 6)).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(timeTicks(0, 5)).toEqual([0]);
    expect(formatTick(90, 120)).toBe('1:30');
    expect(formatTick(2.5, 10)).toBe('2.5s');
    expect(singerVar('shawn-mendes', '#b97a12')).toBe('var(--singer-shawn)');
    expect(singerVar('custom', '#123456')).toBe('#123456');
    expect(singerVar(undefined)).toBe('var(--singer-custom)');
  });

  it('progress points filter by profile and metric, oldest first', () => {
    const sessions: SessionRecord[] = [...makeFakeSessions(3)].reverse();
    sessions.push({ ...makeFakeSessions(1, 'other')[0], id: 'x' });
    const pts = progressPoints(sessions, 'test-singer', 'overall');
    expect(pts.map((p) => p.session.id)).toEqual(['s0', 's1', 's2']);
    expect(progressPoints(sessions, undefined, 'overall')).toHaveLength(4);
    expect(progressPoints(sessions, 'test-singer', 'rasp')).toHaveLength(0);
  });

  it('date labels keep a minimum gap and always include the newest', () => {
    expect(labelIndices([0, 10, 20, 100, 200], 60)).toEqual([0, 3, 4]);
    expect(labelIndices([0, 30], 60)).toEqual([1]);
    expect(labelIndices([], 60)).toEqual([]);
  });

  it('reference diff helpers split gaps, bound the extent and decimate', () => {
    const runs = diffRuns([
      { userT: 0.2, refT: 0, centsDiff: 10 },
      { userT: 0, refT: 0, centsDiff: 5 },
      { userT: 1, refT: 1, centsDiff: NaN },
      { userT: 2, refT: 2, centsDiff: -30 },
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0].map((p) => p.t)).toEqual([0, 0.2]);
    expect(centsExtent([10, -30])).toBe(100);
    expect(centsExtent([10, -240])).toBe(250);
    expect(centsExtent([5000])).toBe(600);
    expect(decimateRun([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([1, 4, 7]);
    expect(decimateRun([1, 2, 3, 4, 5, 6], 4)).toEqual([1, 5, 6]);
  });
});
