import { axisLabelPlacement, chartPointSpacing, formatAxisDistance, formatAxisElapsed } from '@/lib/chartAxis';

describe('chartPointSpacing', () => {
  it('spans the plot width with n-1 gaps, so the series ends where the chart does', () => {
    // The whole point of this: total drawn width is spacing * (pointCount - 1), which has
    // to land inside plotWidth or gifted-charts makes the chart horizontally scrollable.
    const plotWidth = 302;
    for (const pointCount of [2, 7, 30, 60]) {
      const spacing = chartPointSpacing(plotWidth, pointCount);
      expect(spacing * (pointCount - 1)).toBeLessThanOrEqual(plotWidth);
      expect(spacing * (pointCount - 1)).toBeGreaterThan(plotWidth - 5);
    }
  });

  it('never returns a zero or negative spacing, even before the container is measured', () => {
    expect(chartPointSpacing(0, 30)).toBeGreaterThan(0);
    expect(chartPointSpacing(300, 1)).toBeGreaterThan(0);
    expect(chartPointSpacing(300, 0)).toBeGreaterThan(0);
  });
});

describe('axisLabelPlacement', () => {
  const SPACING = 10;
  const LABEL_WIDTH = 64;

  it('turns the first and last labels inward so their overflow stays on the chart', () => {
    // Slot coordinates: the slot is `spacing` wide and its centre (spacing/2) is the data
    // point. A centred first label would start at spacing/2 - 32, i.e. 27px left of the
    // chart's own left edge, which is where "0.0km" was being clipped to "km".
    const first = axisLabelPlacement(0, 30, SPACING, LABEL_WIDTH);
    expect(first.align).toBe('left');
    expect(first.left).toBe(SPACING / 2);

    const last = axisLabelPlacement(29, 30, SPACING, LABEL_WIDTH);
    expect(last.align).toBe('right');
    expect(last.left + LABEL_WIDTH).toBe(SPACING / 2);
  });

  it('centres every label in between on its own data point', () => {
    const middle = axisLabelPlacement(10, 30, SPACING, LABEL_WIDTH);
    expect(middle.align).toBe('center');
    expect(middle.left + LABEL_WIDTH / 2).toBe(SPACING / 2);
  });

  it('treats a lone point as the first one rather than falling through to centred', () => {
    expect(axisLabelPlacement(0, 1, SPACING, LABEL_WIDTH).align).toBe('left');
  });
});

describe('formatAxisDistance', () => {
  it('uses metres below a kilometre, where one decimal of a km would collide', () => {
    // Four ticks over a 300m route: 0.1km/0.2km/0.2km/0.3km reads as a repeat.
    expect(formatAxisDistance(0, 0.3)).toBe('0m');
    expect(formatAxisDistance(0.1, 0.3)).toBe('100m');
    expect(formatAxisDistance(0.2, 0.3)).toBe('200m');
    expect(formatAxisDistance(0.3, 0.3)).toBe('300m');
  });

  it('uses kilometres once the route is long enough for them to differ', () => {
    expect(formatAxisDistance(0, 11.2)).toBe('0.0km');
    expect(formatAxisDistance(11.24, 11.24)).toBe('11.2km');
  });
});

describe('formatAxisElapsed', () => {
  it('uses m:ss on a short ride, where whole minutes repeat', () => {
    // The regression this replaces: a 3-minute trip labelled ticks "0m 1m 1m 2m 2m 3m".
    const total = 3 * 60_000;
    const ticks = [0, 60_000, 120_000, 180_000].map((ms) => formatAxisElapsed(ms, total));
    expect(ticks).toEqual(['0:00', '1:00', '2:00', '3:00']);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(formatAxisElapsed(95_000, total)).toBe('1:35');
  });

  it('uses whole minutes once the ride is long enough for them to differ', () => {
    const total = 42 * 60_000;
    expect(formatAxisElapsed(0, total)).toBe('0m');
    expect(formatAxisElapsed(14 * 60_000, total)).toBe('14m');
    expect(formatAxisElapsed(total, total)).toBe('42m');
  });

  it('clamps a sample timestamped before the trip start rather than showing negative time', () => {
    expect(formatAxisElapsed(-5_000, 42 * 60_000)).toBe('0m');
  });
});
