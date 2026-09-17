import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { StatusBarScrim } from '@/components/ui/StatusBarScrim';
import { GLASS_GRADIENT, useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';

/** Full-screen glass-mode gradient fill + status bar scrim, shared by every
 * pushed/full-screen view so a container-style change only has one call site to update. */
export function GlassBackdrop() {
  const { containerStyle } = useAppTheme();
  const colorScheme = useColorScheme();

  return (
    <>
      {containerStyle === 'glass' && (
        <LinearGradient colors={GLASS_GRADIENT[colorScheme]} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />
      )}
      <StatusBarScrim />
    </>
  );
}
