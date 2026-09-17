import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { LineChart } from 'react-native-gifted-charts';

import { Text, useThemeColor } from '@/components/Themed';
import { ChartAxisLabel } from '@/components/ui/ChartAxisLabel';
import { useAppTheme } from '@/lib/theme';
import { CHART_AXIS_TICK_COUNT, axisLabelPlacement, chartPointSpacing, formatAxisElapsed, useChartPlotWidth } from '@/lib/chartAxis';
import { pickTickIndices } from '@/features/rides/elevationProfile';
import type { VoltageSample } from '@/features/rides/tripTypes';
import { useDeviceNoun } from '@/features/device/deviceNoun';

// Same reserved y-axis label width ElevationChart passes explicitly, rather than
// trusting gifted-charts' own unstated default (see that component's identical constant).
const CHART_Y_AXIS_LABEL_WIDTH = 34;
// Plot height plus the band gifted-charts adds below the x axis for its labels, reserved
// up front so the card doesn't resize once the measured width arrives.
const CHART_HEIGHT = 120;
const CHART_FRAME_HEIGHT = CHART_HEIGHT + 60;
// gifted-charts ellipsizes any label wider than its per-point slot to "…" — a
// labelComponent (axisLabelPlacement/ChartAxisLabel, shared with ElevationChart) draws
// the time text itself, overflowing its narrow slot instead. Width fits the widest
// realistic label ("180m" at fontSize 10) plus a little slack.
const X_AXIS_LABEL_WIDTH = 50;

// Real, confirmed-in-production crash this bounds: the native ride journal's own dp
// push stream can carry thousands of voltage samples for one ride (dp20 lands on
// nearly every push while riding), and this chart passed gifted-charts neither
// `spacing` nor `adjustToWidth` -- so it fell back to the library's fixed per-point
// pixel spacing regardless of container width. Thousands of points at that fixed
// spacing overflowed Android's own per-bitmap Canvas draw-size limit outright
// (`Canvas: trying to draw too large bitmap`, thrown from
// RecordingCanvas.throwIfCannotDraw), crashing the app the instant this chart tried to
// render. ElevationChart already solved this identical problem for the elevation
// profile (see its own MAX_CHART_POINTS comment) -- decimate first, then space the
// survivors to exactly fill the card, same pattern here.
const MAX_VOLTAGE_CHART_POINTS = 60;

/** Voltage-over-time graph, from the device's voltage readings while a trip was RIDING.
 * `plausibleVoltageV` comes from the ride's device profile: a reading outside it is a
 * decoding error rather than a battery (a new brand's voltage scale is the first thing
 * that can be wrong), and one bad sample would otherwise flatten the whole curve. */
export function VoltageGraph({
  voltageSamples,
  tripStartMs,
  plausibleVoltageV,
}: {
  voltageSamples: VoltageSample[];
  tripStartMs: number;
  plausibleVoltageV?: { min: number; max: number };
}) {
  const noun = useDeviceNoun();
  const { accentColor } = useAppTheme();
  const axisTextColor = useThemeColor({}, 'text');

  // Decimate BEFORE building labels/spacing, so the labeled ticks land on points that
  // actually survive into the rendered chart -- same ordering ElevationChart's
  // buildElevationData uses. Hooks must run unconditionally (before the empty-state
  // early return below), same reasoning as ElevationChart's own chartData memo.
  const decimated = useMemo(() => {
    const sorted = voltageSamples
      .filter((s) => !plausibleVoltageV || (s.voltage >= plausibleVoltageV.min && s.voltage <= plausibleVoltageV.max))
      .sort((a, b) => a.timestampMs - b.timestampMs);
    const displayIndices = Array.from(pickTickIndices(sorted.length, MAX_VOLTAGE_CHART_POINTS)).sort((a, b) => a - b);
    return displayIndices.map((i) => sorted[i]);
  }, [voltageSamples, plausibleVoltageV]);

  // Points spaced to exactly fill the measured card width, however many survive
  // decimation -- never requires horizontal scrolling, and never overflows the Canvas
  // draw-size limit regardless of how dense the underlying sample series was.
  const { plotWidth, onLayout } = useChartPlotWidth(CHART_Y_AXIS_LABEL_WIDTH);
  const spacing = chartPointSpacing(plotWidth, decimated.length);

  const chartData = useMemo(() => {
    const tickIndices = pickTickIndices(decimated.length, CHART_AXIS_TICK_COUNT);
    // Ticks read as elapsed ride time, so the scale has to come from the ride's own
    // length -- not from the last sample's absolute clock value.
    const totalMs = decimated.length ? decimated[decimated.length - 1].timestampMs - tripStartMs : 0;
    return decimated.map((s, i) => {
      if (!tickIndices.has(i)) return { value: s.voltage, label: '' };
      const label = formatAxisElapsed(s.timestampMs - tripStartMs, totalMs);
      const { left, align } = axisLabelPlacement(i, decimated.length, spacing, X_AXIS_LABEL_WIDTH);
      return {
        value: s.voltage,
        label,
        labelComponent: () => <ChartAxisLabel label={label} left={left} align={align} width={X_AXIS_LABEL_WIDTH} color={axisTextColor} />,
      };
    });
  }, [decimated, tripStartMs, axisTextColor, spacing]);

  if (decimated.length < 2) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          {voltageSamples.length === 0
            ? `No voltage samples recorded. The ${noun.lower} may have been unreachable during this ride.`
            : decimated.length === 0
              ? `The ${noun.lower} reported voltages outside a real battery's range, so there's nothing to draw.`
              : 'Not enough voltage samples yet to draw a trend.'}
        </Text>
      </View>
    );
  }

  // The default axis starts at 0, so a real ~52-57V range renders as a sliver at the
  // top of a 0-60V chart. E-board battery voltage never goes anywhere near 0 in
  // practice, so scale the axis to the trip's actual min/max instead (with a little
  // padding, and a floor on the span so a trip with truly zero variance still renders
  // a sane, non-degenerate band rather than a single flat pixel row).
  const values = decimated.map((s) => s.voltage);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const span = Math.max(dataMax - dataMin, 0.6);
  const yAxisOffset = Math.floor((dataMin - span * 0.2) * 10) / 10;
  const topValue = Math.ceil((dataMax + span * 0.2) * 10) / 10;
  const noOfSections = 3;
  const stepValue = Math.round(((topValue - yAxisOffset) / noOfSections) * 100) / 100;

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
