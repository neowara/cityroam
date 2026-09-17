import { StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { CloudOff } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useColorScheme } from '@/components/useColorScheme';
import { useAppTheme } from '@/lib/theme';

/** Covers a trip-detail module that only backend enrichment can fill in (elevation,
 * trip-by-mode) with a blur + "needs to sync" message and a retry button, for a trip
 * that hasn't been uploaded yet — rather than the module just rendering its normal
 * empty state, which reads as "this trip has no data" instead of "this data exists,
 * upload to see it." Render as an absolutely-positioned sibling over real (if empty)
 * module content, inside a `position: 'relative'` parent. */
export function SyncRequiredOverlay({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const colorScheme = useColorScheme() ?? 'light';
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <BlurView intensity={35} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill} />
      <View style={styles.center} pointerEvents="box-none">
        <CloudOff size={18} color={inkDim} />
        <Text style={[styles.text, { color: inkDim }]}>Needs to sync with server</Text>
        <PressableScale onPress={onRetry} disabled={retrying} style={[styles.button, { backgroundColor: accentColor }]}>
          <Text style={styles.buttonText}>{retrying ? 'Syncing…' : 'Sync now'}</Text>
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  text: { fontSize: 12, fontWeight: '600' },
  button: { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 14 },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 12 },
});
