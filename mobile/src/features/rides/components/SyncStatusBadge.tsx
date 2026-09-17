import { StyleSheet, View } from 'react-native';
import { Server, Smartphone } from 'lucide-react-native';

import { useThemeColor } from '@/components/Themed';

/** Small corner badge marking whether a trip lives on the backend (green server icon)
 * or only in this device's local offline queue, not uploaded yet (red phone icon) —
 * see lib/localTrips.ts for how a trip's id itself already encodes this (negative =
 * local). Absolutely positioned — render inside a `position: 'relative'` parent sized
 * to whatever corner it should sit on (a map thumbnail, a row, a card). */
export function SyncStatusBadge({
  synced,
  size = 11,
  inline = false,
}: {
  synced: boolean;
  size?: number;
  // Plain, statically-laid-out icon (no absolute corner positioning) — for contexts
  // with no card/thumbnail corner to anchor to, like trip/[id].tsx's header row,
  // sitting inline next to ModeChip/WeatherBadge the same way those already do.
  inline?: boolean;
}) {
  const good = useThemeColor({}, 'good');
  const crit = useThemeColor({}, 'crit');
  const surface = useThemeColor({}, 'surface');
  const Icon = synced ? Server : Smartphone;
  const color = synced ? good : crit;

  if (inline) return <Icon size={size} color={color} />;

  const diameter = size + 11;
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: surface,
          borderColor: color,
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
          top: -diameter * 0.3,
          right: -diameter * 0.3,
        },
      ]}>
      <Icon size={size} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
});
