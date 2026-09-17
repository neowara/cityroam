import { Switch, View } from 'react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { styles } from '@/features/settings/styles';
import { useAppTheme } from '@/lib/theme';

/** A notification's on/off switch plus a link to its Android channel settings. A channel
 * the rider blocked in Android shows as off and disabled, since the app can't unblock it. */
export function NotificationToggleRow({
  label,
  note,
  value,
  blocked,
  onValueChange,
  onOpenChannelSettings,
}: {
  label: string;
  note: string;
  value: boolean;
  blocked: boolean;
  onValueChange: (v: boolean) => void;
  onOpenChannelSettings: () => void;
}) {
  const { accentColor } = useAppTheme();
  return (
    <View style={styles.notificationRow}>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Switch value={value && !blocked} disabled={blocked} onValueChange={onValueChange} />
      </View>
      <Text style={styles.note}>{blocked ? 'Blocked in Android’s notification settings for this app.' : note}</Text>
      <PressableScale onPress={onOpenChannelSettings}>
        <Text style={[styles.notificationLink, { color: accentColor }]}>Sound and vibration</Text>
      </PressableScale>
    </View>
  );
}
