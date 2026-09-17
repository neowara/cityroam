import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { LucideIcon } from 'lucide-react-native';

import { FitText } from '@/components/ui/FitText';
import { fontStyleFor, useAppTheme } from '@/lib/theme';

/** The icon+title row every screen opens with, shared so all 4 tabs match. `insets.top`
 * restores the breathing room the native header used to reserve — without it, content
 * runs edge-to-edge under the transparent (Android 15+ enforced) status bar. */
export function ScreenHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  const { accentColor: tint, font } = useAppTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.topbar, { marginTop: insets.top + 8 }]}>
      <Icon size={22} color={tint} />
      <FitText style={[styles.title, fontStyleFor(font)]}>{title}</FitText>
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  title: { fontSize: 22 },
});
