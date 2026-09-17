import { StyleSheet } from 'react-native';

import { Text } from '@/components/Themed';
import type { ChartAxisAlign } from '@/lib/chartAxis';

/**
 * A gifted-charts `LineChart` x-axis label rendered as a `labelComponent` instead of
 * the library's own truncating `label` string — gifted-charts ellipsizes any label
 * wider than its narrow per-point slot to "…", so this draws the text itself,
 * absolutely positioned to escape that slot. `left`/`align` come from
 * `axisLabelPlacement` (lib/chartAxis.ts), which turns the first and last ticks inward
 * so their overflow stays inside the plot area.
 */
export function ChartAxisLabel({
  label,
  left,
  width,
  color,
  align,
}: {
  label: string;
  left: number;
  width: number;
  color: string;
  align: ChartAxisAlign;
}) {
  return (
    <Text style={[styles.label, { color, left, width, textAlign: align }]} numberOfLines={1}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    position: 'absolute',
    fontSize: 10,
  },
});
