import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { weatherMeta } from '@/lib/weather';

/**
 * Weather icon(s) + feels-like temp + average wind speed (m/s) — trip detail,
 * dashboard cards, rides list rows. Multiple icons only when a ride genuinely spanned
 * more than one distinct condition (e.g. started clear, ended rainy) — most rides are
 * short enough that weatherCodes has just one entry.
 */
export function WeatherBadge({
  weatherCodes,
  feelsLikeC,
  windSpeedMs,
  size = 13,
  color,
}: {
  weatherCodes: number[] | null;
  feelsLikeC: number | null;
  windSpeedMs: number | null;
  size?: number;
  color: string;
}) {
  if (!weatherCodes || weatherCodes.length === 0) return null;
  const icons = weatherCodes.map((code) => weatherMeta(code)).filter((m): m is NonNullable<typeof m> => m != null);
  if (icons.length === 0) return null;

  return (
    <View style={styles.row}>
      <View style={styles.icons}>
        {icons.map(({ Icon }, i) => (
          <Icon key={i} size={size} color={color} />
        ))}
      </View>
      {(feelsLikeC != null || windSpeedMs != null) && (
        <Text style={[styles.text, { fontSize: size - 1, color }]}>
          {feelsLikeC != null ? `${Math.round(feelsLikeC)}°` : ''}
          {feelsLikeC != null && windSpeedMs != null ? ' · ' : ''}
          {windSpeedMs != null ? `${windSpeedMs.toFixed(1)} m/s` : ''}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  text: { fontVariant: ['tabular-nums'] },
});
