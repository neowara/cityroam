import { StyleSheet, View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { fontStyleFor, useAppTheme } from '@/lib/theme';

/**
 * A dashboard module's title in the app's brand face — the same treatment "Plan a
 * trip" and "Start trip" use — with its icon in the theme tint. Shared so every
 * dashboard heading ("Last ride", "Recent rides", "Range by mode") stays in one style.
 */
export function ModuleTitle({ children, icon: Icon }: { children: string; icon: LucideIcon }) {
  const { font } = useAppTheme();
  const tint = useThemeColor({}, 'tint');
  return (
    <View style={styles.row}>
      <Icon size={15} color={tint} />
      <Text style={[styles.text, fontStyleFor(font)]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { fontSize: 15 },
});
