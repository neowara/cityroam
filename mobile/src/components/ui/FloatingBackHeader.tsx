import type { ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { ArrowLeft, type LucideIcon } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// The project's own hook, not React Native's: RN's ColorSchemeName includes
// 'unspecified', which BlurView's tint prop does not accept.
import { useColorScheme } from '@/components/useColorScheme';
import { Text, useThemeColor } from '@/components/Themed';
import { GlassFill } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';

/** Gap between the safe area and the pill. */
export const PILL_TOP_OFFSET = 28;
/** Height to keep clear beneath the pill so content doesn't start underneath it. */
export const PILL_CLEARANCE = 60;

/**
 * The floating back pill used by every screen that navigates back to another one.
 *
 * Absolutely positioned rather than sitting in normal flow, so scrolled content passes
 * behind it instead of stopping at a reserved band that reads as its own solid
 * container. Pair it with `contentContainerStyle={{ paddingTop: insets.top +
 * PILL_TOP_OFFSET + PILL_CLEARANCE }}` on the scroll view underneath.
 */
export function FloatingBackHeader({
  icon: Icon,
  title,
  onPress,
  right,
}: {
  icon?: LucideIcon;
  title: string;
  onPress: () => void;
  /** Optional trailing action, given its own matching pill on the right. */
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { accentColor, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const surface = useThemeColor({}, 'surface');
  const isGlass = containerStyle === 'glass';

  return (
    <View style={[styles.wrap, { marginTop: insets.top + PILL_TOP_OFFSET }]} pointerEvents="box-none">
      <PressableScale
        onPress={onPress}
        hitSlop={10}
        style={[styles.pill, { borderColor: accentColor + '55' }, isGlass ? styles.pillGlass : { backgroundColor: surface }]}>
        {/* Matches Card's own glass treatment: blurMethod="none" because Android gets no
            real blur from BlurView anyway (GlassFill's tint+sheen is what reads as
            "glass"), and BlurView on Android doesn't reliably reposition after a
            re-layout. iOS keeps the real hardware blur. */}
        {isGlass && Platform.OS !== 'android' && (
          <BlurView intensity={70} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill} />
        )}
        {isGlass && <GlassFill />}
        {/* GlassFill's tint is tuned for a large card sitting above matching-color text.
            On a small pill floating over arbitrary scrolled content it is too faint, and
            the arrow and title stop being legible against whatever passes underneath —
            so a little extra opacity on top, which keeps the glass look either way. */}
        {isGlass && (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, colorScheme === 'dark' ? styles.glassBoostDark : styles.glassBoostLight]}
          />
        )}
        <ArrowLeft size={22} color={inkDim} />
        {Icon && <Icon size={20} color={accentColor} />}
        <Text style={styles.title}>{title}</Text>
      </PressableScale>
      {right && (
        <View
          style={[
            styles.pill,
            styles.rightPill,
            { borderColor: accentColor + '55' },
            isGlass ? styles.pillGlass : { backgroundColor: surface },
          ]}>
          {isGlass && Platform.OS !== 'android' && (
            <BlurView intensity={70} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill} />
          )}
          {isGlass && <GlassFill />}
          {isGlass && (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, colorScheme === 'dark' ? styles.glassBoostDark : styles.glassBoostLight]}
            />
          )}
          {right}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 20,
  },
  // Shrink-wraps its content rather than spanning the full width, so the surrounding
  // header stays transparent.
  //
  // No elevation, deliberately: Android ignores the iOS shadow props and only honours
  // `elevation`, and at this size it paints as a near-solid rectangle across the whole
  // header row rather than a soft shadow — exactly the solid band this avoids.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    // Clips the glass fill/blur to the rounded shape instead of a square corner showing.
    overflow: 'hidden',
  },
  // Squarer padding than the title pill: it holds a single icon, not a row of text.
  rightPill: { paddingHorizontal: 12 },
  pillGlass: { backgroundColor: 'transparent' },
  glassBoostDark: { backgroundColor: 'rgba(20,20,24,0.6)' },
  glassBoostLight: { backgroundColor: 'rgba(255,255,255,0.55)' },
  title: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 },
});
