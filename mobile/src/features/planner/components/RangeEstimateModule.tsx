import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BarChart } from 'react-native-gifted-charts';
import { Gauge, MapPin, TrendingUp, Zap } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { FitText } from '@/components/ui/FitText';
import { ModeText } from '@/components/ui/ModeText';
import { BatteryLiveSwitch } from '@/features/device/components/BatteryLiveSwitch';
import { PressableScale } from '@/components/ui/PressableScale';
import { MODE_META, MODE_ICONS, MODE_ORDER } from '@/lib/mode';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { fontStyleFor, useAppTheme } from '@/lib/theme';
import { useLiveRiderWeightKg, useRangeEstimate, useRefetchOnFocus, type BatteryScenario } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { useDeviceProfileFor } from '@/features/device/deviceProfile';
import { ModuleTitle } from '@/components/ui/ModuleTitle';

/**
 * Real board telemetry only — no fabricated stats. Tuya's API for this board exposes
 * battery_percentage, voltage_current, speed, mileage, and ride mode; nothing about
 * braking. Estimated range/battery duration come from aggregating real trip history
 * per dominant mode (backend/app/services/range_estimate.py); avg/max speed are real
 * per-mode figures correlated from actual route-point speed samples, not the whole
 * trip's speed attributed to whichever mode happened to dominate it.
 */
export function RangeEstimateModule() {
  const noun = useDeviceNoun();
  const { deviceId } = useTripDeviceFilter();
  // Only the modes the device actually has get a row — a scooter isn't a four-mode board.
  const { rideModes } = useDeviceProfileFor(deviceId);
  const liveRiderWeightKg = useLiveRiderWeightKg();
  // view the range at the board's current charge or at a
  // hypothetical full battery. 'current' (default) keeps the live-or-last-known
  // behavior; 'full' asks the backend for a 100% estimate. The scenario is part of the
  // query key, so toggling refetches instead of serving the other scenario's cache.
  const [scenario, setScenario] = useState<BatteryScenario>('current');
  const { data, refetch } = useRangeEstimate(deviceId, liveRiderWeightKg, scenario);
  useRefetchOnFocus(refetch);
  const [selected, setSelected] = useState<(typeof MODE_ORDER)[number]>('eco');
  const { font } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');

  if (!data) return null;

  const modes = data.modes;
  const selectedData = modes[selected];
  const meta = MODE_META[selected];
  const SelectedIcon = MODE_ICONS[selected];

  // Voltage-curve estimate as a fallback, not a replacement — Tuya's coarse
  // whole-integer battery reading is the primary source when it has anything to say;
  // the continuous voltage-derived one only fills in while that's still "learning".
  const rangeFor = (m: (typeof MODE_ORDER)[number]) => modes[m]?.estimatedRangeKm ?? modes[m]?.estimatedRangeKmVoltage ?? null;
  const isEstimatedFor = (m: (typeof MODE_ORDER)[number]) =>
    modes[m]?.estimatedRangeKm == null && modes[m]?.estimatedRangeKmVoltage != null;
  // Confidence band — low/high bracket the point estimate, widening with little
  // history and narrowing as sampleTripCount grows. Shown as "20-25km". The band only comes
  // from the whole-percent trip-history model, never the voltage fallback, so the UI keeps
  // the "~" for that estimate instead of pretending there's a confidence band.
  const bandFor = (m: (typeof MODE_ORDER)[number]) => {
    const d = modes[m];
    if (d?.estimatedRangeKmLow != null && d?.estimatedRangeKmHigh != null) {
      // Floor/ceil outward so the displayed band never claims more precision than the model.
      return { low: Math.floor(d.estimatedRangeKmLow), high: Math.ceil(d.estimatedRangeKmHigh) };
    }
    return null;
  };
  const selBand = bandFor(selected);

  const chartData = rideModes.map((m) => ({
    value: rangeFor(m) ?? 0,
    label: MODE_META[m].label,
    frontColor: MODE_META[m].color,
  }));
  const hasAnyRange = chartData.some((d) => d.value > 0);
  // Axis must scale to real data, not a fixed 0/10/20/30 — a single-ride mode's small
  // value was getting flattened against an oversized default max.
  const rawMax = Math.max(...chartData.map((d) => d.value), 0);
  const niceStep = rawMax <= 20 ? 5 : rawMax <= 40 ? 10 : rawMax <= 80 ? 20 : 25;
  const chartMax = Math.max(niceStep, Math.ceil(rawMax / niceStep) * niceStep);
  const chartSections = Math.round(chartMax / niceStep);

  return (
    <Card>
      <View style={styles.titleRow}>
        <ModuleTitle icon={Gauge}>Range by mode</ModuleTitle>
        <BatteryLiveSwitch live={scenario === 'current'} onChange={(live) => setScenario(live ? 'current' : 'full')} />
      </View>

      <View style={styles.tiles}>
        {rideModes.map((m) => {
          const TileIcon = MODE_ICONS[m];
          const d = modes[m];
          const range = rangeFor(m);
          const band = bandFor(m);
          const isSelected = m === selected;
          const color = MODE_META[m].color;
          return (
            <PressableScale
              key={m}
              onPress={() => setSelected(m)}
              style={[styles.tile, { borderColor: isSelected ? color : color + '33' }, isSelected && { backgroundColor: color + '18' }]}>
              <TileIcon size={18} color={color} />
              <FitText style={[styles.tileValue, fontStyleFor(font)]}>
                {band != null ? `${band.low}-${band.high}` : range != null ? `${isEstimatedFor(m) ? '~' : ''}${range}` : '–'}
              </FitText>
              <Text style={[styles.tileUnit, { color: inkDim }]}>
                {band != null || range != null ? 'km' : d.sampleTripCount > 0 ? 'learning' : 'no data'}
              </Text>
              <ModeText mode={m} style={styles.tileLabel} />
            </PressableScale>
          );
        })}
      </View>

      {selectedData.sampleTripCount === 0 ? (
        <View style={styles.emptyWrap}>
          <SelectedIcon size={20} color={inkFaint} />
          <Text style={[styles.emptyText, { color: inkFaint }]}>
            No <ModeText mode={selected} /> rides recorded yet. Ride in <ModeText mode={selected} lowercase /> mode to build an estimate.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.statsGrid}>
            <Stat
              icon={<MapPin size={13} color={meta.color} />}
              label="Est. range"
              value={
                selBand != null
                  ? `${selBand.low}-${selBand.high} km`
                  : rangeFor(selected) != null
                    ? `${isEstimatedFor(selected) ? '~' : ''}${rangeFor(selected)} km`
                    : 'Learning'
              }
              inkDim={inkDim}
            />
            <Stat
              icon={<TrendingUp size={13} color={meta.color} />}
              label="Battery duration"
              value={selectedData.batteryPctPerKm != null ? `${selectedData.batteryPctPerKm}% / km` : 'Learning'}
              inkDim={inkDim}
            />
            <Stat
              icon={<Gauge size={13} color={meta.color} />}
              label="Avg speed"
              value={selectedData.avgSpeedKmh != null ? `${selectedData.avgSpeedKmh} km/h` : '–'}
              inkDim={inkDim}
            />
            <Stat
              icon={<Zap size={13} color={meta.color} />}
              label="Max speed"
              value={selectedData.maxSpeedKmh != null ? `${selectedData.maxSpeedKmh} km/h` : '–'}
              inkDim={inkDim}
            />
          </View>
          <Text style={[styles.sampleNote, { color: inkFaint }]}>
            {scenario === 'full' ? (
              'At a full battery'
            ) : (
              <>
                Based on {selectedData.sampleTripCount} ride{selectedData.sampleTripCount === 1 ? '' : 's'} in{' '}
                <ModeText mode={selected} lowercase /> mode
                {isEstimatedFor(selected) ? ' · ~ = estimated from battery voltage, not yet a whole-percent change' : ''}
                {selBand != null && !isEstimatedFor(selected) ? ' · shown as a low to high range, wider while there are few rides' : ''}
                {data.stale ? ` · ${noun.lower} offline, using the last known battery level` : ''}
              </>
            )}
          </Text>

          {hasAnyRange && (
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
        </>
      )}
    </Card>
  );
}

function Stat({ icon, label, value, inkDim }: { icon: React.ReactNode; label: string; value: string; inkDim: string }) {
  return (
    <View style={styles.stat}>
      <View style={styles.statLabelRow}>
        {icon}
        <Text style={[styles.statLabel, { color: inkDim }]}>{label}</Text>
      </View>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tiles: { flexDirection: 'row', gap: 8, marginTop: 4 },
  tile: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  tileValue: { fontSize: 17, marginTop: 2 },
  tileUnit: { fontSize: 10 },
  tileLabel: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  emptyWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, paddingHorizontal: 4 },
  emptyText: { fontSize: 12.5, flex: 1, lineHeight: 17 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 8 },
  stat: { width: '45%', gap: 2 },
  statLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statLabel: { fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: '600' },
  statValue: { fontSize: 16, fontVariant: ['tabular-nums'] },
  sampleNote: { fontSize: 11, marginTop: 10 },
  chartWrap: { marginTop: 10, alignItems: 'flex-start' },
});
