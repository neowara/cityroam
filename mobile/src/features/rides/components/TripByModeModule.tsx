import { StyleSheet, View } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { BatteryMedium } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { FitText } from '@/components/ui/FitText';
import { ModeText } from '@/components/ui/ModeText';
import { SectionLabel } from '@/components/ui/SectionLabel';
import { MODE_META, MODE_ICONS, MODE_ORDER, type Mode } from '@/lib/mode';
import { fontStyleFor, useAppTheme } from '@/lib/theme';
import { useTripByMode } from '@/lib/queries';

// Derived from MODE_META.eco.color (not a fresh literal) so the "most efficient" border
// color can never drift from the eco color used elsewhere (e.g. the savings-row icon).
const MOST_EFFICIENT_GREEN = MODE_META.eco.color;

/**
 * Shows what this ride's own real route would have cost in each mode —
 * backend/app/services/trip_by_mode.py re-simulates the same physics for the trip's
 * actual conditions, so a rider can see what riding differently would have meant for
 * battery use, mode by mode. Only the modes the ride's own device has get a tile
 * (`rideModes`, from its device profile) — a scooter with two modes shows two.
 */
export function TripByModeModule({ tripId, rideModes = MODE_ORDER }: { tripId: number; rideModes?: readonly Mode[] }) {
  const { data } = useTripByMode(tripId);
  const { font } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');

  if (!data || Object.keys(data.modes).length === 0) return null;

  const actualMode = data.actualMode;
  // costFor takes a plain string (not Mode) because data.modes is keyed by whatever the
  // backend sent -- actualMode is a string over the wire, and MODE_ORDER's Mode values
  // are assignable to string, so one signature serves both without an unsafe cast.
  const costFor = (m: string) =>
    m === actualMode && data.actualBatteryUsedPct != null ? data.actualBatteryUsedPct : (data.modes[m]?.estimatedBatteryUsedPct ?? null);

  const costs = rideModes.map((m) => costFor(m)).filter((v): v is number => v != null);
  const cheapest = costs.length > 0 ? Math.min(...costs) : null;
  // The mode whose predicted/actual cost equals the cheapest — the "most efficient" tile
  // that gets the green border. First match wins on a tie; null when no mode has data.
  const cheapestMode = cheapest != null ? (rideModes.find((m) => costFor(m) === cheapest) ?? null) : null;
  // actualMode comes from the backend's mode_display() -- always one of ALL_MODES or
  // null, same values MODE_ORDER enumerates, but typed as a plain string over the wire.
  const actualCost = actualMode ? costFor(actualMode) : null;
  // How much less battery the most efficient mode would have used vs. the mode actually
  // ridden — the whole point of this module (maximize battery usage per the user's own
  // framing), so it's surfaced as a headline, not buried in the tiles.
  const savingsPct = actualCost != null && cheapest != null && actualCost > cheapest ? actualCost - cheapest : null;

  const chartData = rideModes.map((m) => ({
    value: costFor(m) ?? 0,
    label: MODE_META[m].label,
    frontColor: MODE_META[m].color,
  }));
  const hasAnyCost = chartData.some((d) => d.value > 0);
  const rawMax = Math.max(...chartData.map((d) => d.value), 0);
  const niceStep = rawMax <= 10 ? 2 : rawMax <= 25 ? 5 : rawMax <= 50 ? 10 : 20;
  const chartMax = Math.max(niceStep, Math.ceil(rawMax / niceStep) * niceStep);
  const chartSections = Math.round(chartMax / niceStep);

  return (
    <Card>
      <SectionLabel icon={BatteryMedium}>By mode</SectionLabel>
      <Text style={[styles.subtitle, { color: inkDim }]}>What this ride would have cost in each mode</Text>

      {cheapestMode && (
        <View style={styles.savingsRow}>
          <BatteryMedium size={14} color={MOST_EFFICIENT_GREEN} />
          <Text style={[styles.savingsText, { color: inkDim }]}>
            The most efficient mode for this ride would have been <ModeText mode={cheapestMode} style={{ fontWeight: '600' }} />
            {savingsPct != null && savingsPct >= 0.5 && (
              <>
                {', using '}
                <Text style={styles.savingsHighlight}>{savingsPct.toFixed(1)}%</Text> less battery than{' '}
                {actualMode ? <ModeText mode={actualMode} lowercase /> : 'the mode you rode'}.
              </>
            )}
          </Text>
        </View>
      )}

      <View style={styles.tiles}>
        {rideModes.map((m) => {
          const TileIcon = MODE_ICONS[m];
          const cost = costFor(m);
          const isActual = m === actualMode;
          const isCheapest = m === cheapestMode;
          const color = MODE_META[m].color;
          // Ridden mode keeps its mode-colored border (the "current border style"); the most
          // efficient mode gets a green border. When a mode is both ridden AND most efficient,
          // stack the two borders (green outer, mode-colored inner) so neither hides the other.
          const outerBorder = isCheapest ? MOST_EFFICIENT_GREEN : isActual ? color : color + '33';
          const outerBg = isCheapest || isActual ? (isCheapest ? MOST_EFFICIENT_GREEN : color) + '18' : undefined;
          const stackBorders = isCheapest && isActual;
          return (
            <View key={m} style={[styles.tile, { borderColor: outerBorder }, outerBg != null && { backgroundColor: outerBg }]}>
              <View style={stackBorders ? [styles.tileInner, { borderColor: color, backgroundColor: color + '18' }] : styles.tileInner}>
                <TileIcon size={18} color={color} />
                <FitText style={[styles.tileValue, fontStyleFor(font)]}>{cost != null ? cost.toFixed(1) : '–'}</FitText>
                <Text style={[styles.tileUnit, { color: inkDim }]}>{cost != null ? '% battery' : 'no data'}</Text>
                <View style={styles.tileLabelRow}>
                  <ModeText mode={m} style={styles.tileLabel} />
                </View>
              </View>
            </View>
          );
        })}
      </View>

      {hasAnyCost && (
        <View style={styles.chartWrap}>
          <BarChart
            data={chartData}
            barWidth={28}
            spacing={22}
            height={100}
            maxValue={chartMax}
            noOfSections={chartSections}
            yAxisThickness={0}
            xAxisThickness={1}
            xAxisColor="#8884"
            xAxisLabelTextStyle={{ color: inkDim, fontSize: 11 }}
            yAxisTextStyle={{ color: inkDim, fontSize: 11 }}
            hideRules
            initialSpacing={10}
          />
        </View>
      )}

      <Text style={[styles.footnote, { color: inkFaint }]}>
        {actualMode ? (
          <>
            <ModeText mode={actualMode} style={{ fontWeight: '600' }} />
            {'’s figure is measured from this ride. The other modes are predictions for the same route.'}
          </>
        ) : (
          'Predicted for this ride’s actual route.'
        )}
      </Text>

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { borderColor: MOST_EFFICIENT_GREEN, backgroundColor: MOST_EFFICIENT_GREEN + '18' }]} />
          <Text style={[styles.legendLabel, { color: inkDim }]}>Most efficient mode</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { borderColor: MODE_META[actualMode ?? 'eco']?.color ?? inkFaint }]} />
          <Text style={[styles.legendLabel, { color: inkDim }]}>Mode you rode</Text>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  subtitle: { fontSize: 12, marginTop: 2 },
  savingsRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, marginBottom: 2 },
  savingsText: { fontSize: 12.5, flex: 1, lineHeight: 17 },
  savingsHighlight: { fontWeight: '700' },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 10 },
  tile: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1.5,
    padding: 1.5,
  },
  // Content layout lives on the inner view so a stacked second border (ridden mode that is
  // also the most efficient) can sit inside the outer border without overlapping it.
  tileInner: {
    alignItems: 'center',
    gap: 3,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
  },
  tileValue: { fontSize: 17, marginTop: 2 },
  tileUnit: { fontSize: 10 },
  tileLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  tileLabel: { fontSize: 11, fontWeight: '600' },
  chartWrap: { marginTop: 14, alignItems: 'flex-start' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 16, height: 16, borderRadius: 4, borderWidth: 1.5 },
  legendLabel: { fontSize: 11 },
  footnote: { fontSize: 11, marginTop: 10, lineHeight: 15 },
});
