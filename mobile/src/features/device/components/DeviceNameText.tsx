import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';

import { FitText } from '@/components/ui/FitText';
import { fontStyleFor, useAppTheme } from '@/lib/theme';

/**
 * Renders a connected device's name (or its "Your board"/"Your scooter" fallback) in
 * the Cityroam wordmark's own face — ClashDisplay_Bold, uppercase — matching the app's
 * logo rather than the body font. Uses `fontStyleFor`'s tracking, not the wordmark's own
 * -0.02em (tuned for large lowercase text; it collides at small uppercase sizes).
 * `textTransform` uppercases the render only, so the underlying string stays intact for
 * anything else reading it. `fontWeight: undefined` clears any weight a caller's shared
 * row style carries — ClashDisplay_Bold is a single face, and combining it with a
 * `fontWeight` fights the face on Android.
 */
export function DeviceNameText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const { font } = useAppTheme();
  return <FitText style={[style, fontStyleFor(font), styles.uppercase]}>{children}</FitText>;
}

const styles = StyleSheet.create({
  uppercase: { textTransform: 'uppercase', fontWeight: undefined },
});
