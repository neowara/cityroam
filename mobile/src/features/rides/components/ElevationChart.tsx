import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';

import { Text } from '@/components/Themed';
import { ChartAxisLabel } from '@/components/ui/ChartAxisLabel';
import type { RoutePointElevation } from '@/lib/api/rangeEstimate';
import { axisLabelPlacement, chartPointSpacing, useChartPlotWidth } from '@/lib/chartAxis';
import { buildElevationData } from '@/features/rides/elevationProfile';

// Reserved width gifted-charts allocates for the y-axis label column -- subtracted from
// the measured container width before computing point spacing, or the chart would
// overflow by exactly that much and still scroll horizontally.
const CHART_Y_AXIS_LABEL_WIDTH = 34;
// Plot height, plus the band gifted-charts adds below the x axis for its labels --
// reserved up front so the card doesn't visibly resize between the first layout pass
// (which is what supplies the width) and the chart appearing.
const CHART_HEIGHT = 140;
const CHART_FRAME_HEIGHT = CHART_HEIGHT + 60;

// gifted-charts renders each x-axis label inside a slot only `spacing` wide (a few px on
// a 30-point profile) and ellipsizes any label wider than that to "…" (numberOfLines: 1).
// So each tick supplies a labelComponent (axisLabelPlacement/ChartAxisLabel, shared with
// VoltageGraph) that draws the distance text itself, overflowing its narrow slot. Ticks
// sit ~10 points apart (CHART_AXIS_TICK_COUNT over MAX_CHART_POINTS), so the overflow
// never collides with a neighbour. Width must fit the widest label ("123.4km" at
// fontSize 10) plus a little slack.
const X_AXIS_LABEL_WIDTH = 64;

// This app has no runtime response validation anywhere (TS types are compile-time
// only) -- so unavailableReason is treated as untrusted: a non-string or empty value
// falls back to the generic message instead of rendering directly, and length/line
// count are capped so a malformed or unexpectedly huge string can't blow out the card.
const MAX_UNAVAILABLE_REASON_LENGTH = 200;

function sanitizeUnavailableReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_UNAVAILABLE_REASON_LENGTH ? `${trimmed.slice(0, MAX_UNAVAILABLE_REASON_LENGTH - 1)}…` : trimmed;
}

/** Shared with the destination planner — originally inlined there, extracted
 * so a completed trip's detail screen can render the same profile shape for its own
 * (lazily elevation-fetched, see lib/queries.ts's useTripElevation) route. */
export function ElevationChart({
  route,
  accentColor,
  axisTextColor,
  unavailableReason,
}: {
  route: RoutePointElevation[];
  accentColor: string;
  axisTextColor: string;
  // Backend's human-readable "why" (e.g. elevation API out of quota, with a reset
  // time) when set — shown instead of the generic empty state so a missing profile
  // doesn't read as "this route is flat/broken".
  unavailableReason?: string | null;
}) {
  const data = useMemo(() => buildElevationData(route), [route]);

  // Points spaced to exactly fill the measured card width, however many points there are
  // (capped at MAX_CHART_POINTS by buildElevationData) -- the whole profile is always
  // visible at once, never requiring horizontal scrolling to see the shape.
  const { plotWidth, onLayout } = useChartPlotWidth(CHART_Y_AXIS_LABEL_WIDTH);
  const spacing = chartPointSpacing(plotWidth, data?.length ?? 0);

  // Hook must run unconditionally (before any early return) or the hook count changes
  // between renders -- e.g. when lazily-fetched elevation data arrives and data flips
  // from null to a profile, which crashes with "rendered more hooks than during the
  // previous render".
  const chartData = useMemo(
    () =>
      (data ?? []).map((d, i) => {
        if (!d.label) return { value: d.value, label: d.label };
        const { left, align } = axisLabelPlacement(i, data?.length ?? 0, spacing, X_AXIS_LABEL_WIDTH);
        return {
          value: d.value,
          label: d.label,
          labelComponent: () => (
            <ChartAxisLabel label={d.label} left={left} align={align} width={X_AXIS_LABEL_WIDTH} color={axisTextColor} />
          ),
        };
      }),
    [data, axisTextColor, spacing],
  );

  if (!data) {
    const reason = sanitizeUnavailableReason(unavailableReason);
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText} numberOfLines={4} ellipsizeMode="tail">
          {reason ?? 'No elevation data for this route.'}
        </Text>
      </View>
    );
  }
  const values = data.map((d) => d.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = Math.max(dataMax - dataMin, 5);
  const yAxisOffset = Math.floor(dataMin - span * 0.15);
  const topValue = Math.ceil(dataMax + span * 0.15);
  const noOfSections = 3;
  const stepValue = Math.round(((topValue - yAxisOffset) / noOfSections) * 10) / 10;

  return (
    <View onLayout={onLayout} style={styles.frame}>
      {plotWidth > 0 ? (
        <LineChart
          data={chartData}
          height={CHART_HEIGHT}
          thickness={2.5}
          color={accentColor}
          hideDataPoints
          yAxisTextStyle={{ color: axisTextColor, fontSize: 10 }}
          xAxisLabelTextStyle={{ color: axisTextColor, fontSize: 10 }}
          xAxisColor="#8884"
          yAxisColor="#8884"
          yAxisOffset={yAxisOffset}
          yAxisLabelWidth={CHART_Y_AXIS_LABEL_WIDTH}
          stepValue={stepValue}
          noOfSections={noOfSections}
          width={plotWidth}
          initialSpacing={0}
          endSpacing={0}
          spacing={spacing}
          disableScroll
          hideRules
          areaChart
          startFillColor={accentColor}
          endFillColor={accentColor}
          startOpacity={0.25}
          endOpacity={0.02}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { minHeight: CHART_FRAME_HEIGHT },
  empty: { paddingVertical: 24, alignItems: 'center' },
  emptyText: { fontSize: 12, opacity: 0.5, textAlign: 'center' },
});
