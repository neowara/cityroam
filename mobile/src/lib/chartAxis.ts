// Shared x-axis concerns for the trip-detail graphs (elevation profile, voltage over
// time) — layout maths and label formatting, kept in one place so the two charts can't
// drift apart in how they size themselves or label their ticks.

import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

/**
 * How many x-axis ticks get a label. Deliberately few: the labels are drawn wider than
 * their own slot (see axisLabelPlacement) so they can overflow into a neighbour's empty
 * space, and the more ticks there are the less empty space there is to overflow into.
 * Six labels on a phone-width card left them fighting for room and, on a short ride,
 * repeating outright ("0m 1m 1m 2m 2m 3m" on a 3-minute trip).
 */
export const CHART_AXIS_TICK_COUNT = 4;

// The last point, and the label right-aligned to it, would otherwise land exactly on
// the plot area's right edge, where a sub-pixel rounding difference is enough to clip
// it. Two pixels of slack is invisible at this size and removes the whole class of
// off-by-a-fraction edge clipping.
const EDGE_SLACK_PX = 2;

// gifted-charts lays the plot area out to the right of the y-axis label column *and* the
// axis line itself. Miss the line and the chart sits exactly its thickness wider than the
// container it was measured against, which is enough to make it scroll again.
const Y_AXIS_THICKNESS_PX = 1;

export type ChartAxisAlign = 'left' | 'center' | 'right';

/**
 * Measured width of a chart's plot area: the container's real interior minus the column
 * gifted-charts reserves for y-axis labels.
 *
 * Measured rather than derived from the window width, because the surrounding screen and
 * card padding isn't knowable from inside the chart. Guessing it is what left the chart
 * a little wider than its container and therefore horizontally scrollable. `plotWidth`
 * is 0 until the first layout pass; render a placeholder rather than a chart sized off a
 * guess.
 */
export function useChartPlotWidth(yAxisLabelWidth: number): {
  plotWidth: number;
  onLayout: (event: LayoutChangeEvent) => void;
} {
  const [containerWidth, setContainerWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => setContainerWidth(event.nativeEvent.layout.width), []);
  const plotWidth = containerWidth ? Math.max(containerWidth - yAxisLabelWidth - Y_AXIS_THICKNESS_PX, 0) : 0;
  return { plotWidth, onLayout };
}

/**
 * Point-to-point spacing that makes the whole series span exactly the plot width.
 *
 * Paired with `width={plotWidth}`, `initialSpacing`/`endSpacing` of 0 and `disableScroll`
 * on the `LineChart`, this is what keeps the entire ride on screen at once: gifted-charts
 * otherwise spaces points at a fixed pixel width regardless of container size and lets
 * the overflow scroll.
 */
export function chartPointSpacing(plotWidth: number, pointCount: number): number {
  const usable = Math.max(plotWidth - EDGE_SLACK_PX, 1);
  return pointCount > 1 ? usable / (pointCount - 1) : usable;
}

/**
 * Where a tick's label sits inside gifted-charts' own per-point label slot — a box only
 * `spacing` wide, centred on the point, which the library would ellipsize anything wider
 * than down to "…".
 *
 * Middle ticks stay centred on their point and overflow into the blank slots either side.
 * The first and last are aligned inward instead, so their overflow can never fall outside
 * the plot area and get clipped there (a bug: "0.0km" rendering as just "km").
 */
export function axisLabelPlacement(
  index: number,
  pointCount: number,
  spacing: number,
  labelWidth: number,
): { left: number; align: ChartAxisAlign } {
  if (index <= 0) return { left: spacing / 2, align: 'left' };
  if (index >= pointCount - 1) return { left: spacing / 2 - labelWidth, align: 'right' };
  return { left: spacing / 2 - labelWidth / 2, align: 'center' };
}

/** Distance along a route, for an x-axis tick. Switches to whole metres below a
 * kilometre: at one decimal of a km, a short ride's ticks collide into the same label
 * ("0.1km" twice on a 300m route) — the axis has to keep reading as a progression. */
export function formatAxisDistance(km: number, totalKm: number): string {
  if (totalKm < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

/** Elapsed ride time, for an x-axis tick. Whole minutes collide on a short ride (a
 * 3-minute trip labels two separate ticks "1m"), so anything under ten minutes is
 * labelled m:ss instead. */
export function formatAxisElapsed(elapsedMs: number, totalMs: number): string {
  const elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
  if (totalMs < 10 * 60_000) {
    const minutes = Math.floor(elapsedSec / 60);
    const seconds = elapsedSec % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  return `${Math.round(elapsedSec / 60)}m`;
}
