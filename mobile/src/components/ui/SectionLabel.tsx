import { StyleSheet, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { Text } from '@/components/Themed';
import { useAppTheme } from '@/lib/theme';

/**
 * A card's small uppercase heading. Every card heading carries an icon in the accent
 * color so a screen of cards scans the same way from top to bottom — pass `icon`
 * rather than hand-rolling an icon row next to the label.
 */
export function SectionLabel({ children, icon: Icon }: { children: string; icon?: LucideIcon }) {
  const { accentColor } = useAppTheme();
  if (!Icon) return <Text style={styles.label}>{children}</Text>;
  return (
    <View style={styles.row}>
      <Icon size={16} color={accentColor} />
      <Text style={styles.label}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 },
});
