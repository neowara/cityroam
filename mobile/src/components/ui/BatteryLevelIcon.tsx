import { BatteryFull, BatteryLow, BatteryMedium } from 'lucide-react-native';

/** A low/half/full battery glyph for a charge percentage, on the same 0-30/31-60/61-100
 * bands as the battery colors. Unknown charge shows the low glyph. */
export function BatteryLevelIcon({ pct, size, color }: { pct: number | null; size: number; color: string }) {
  if (pct == null || pct <= 30) return <BatteryLow size={size} color={color} />;
  if (pct <= 60) return <BatteryMedium size={size} color={color} />;
  return <BatteryFull size={size} color={color} />;
}
