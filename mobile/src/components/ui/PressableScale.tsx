import { forwardRef } from 'react';
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const PRESSED_SCALE = 0.96;
const PRESSED_OPACITY = 0.85;
const ANIM_DURATION_MS = 110;

/** Drop-in replacement for `Pressable` — adds a fast scale+opacity press animation
 * via Reanimated instead of relying on `TouchableOpacity`'s built-in
 * opacity behavior. Forwards all `Pressable` props/children transparently.
 *
 * Multiplies the press-driven opacity against whatever static `opacity` the caller's own
 * `style` already sets (e.g. a disabled-state dim), rather than overwriting it outright —
 * a plain `opacity: 1 - progress...` would otherwise snap a caller's `opacity: 0.5` back to
 * full opacity at rest, since animatedStyle is applied after the caller's style in the
 * array and RN's style-array flattening lets the later element win per-key (
 * on the "Restore trips"/"Restore N" buttons in settings.tsx, which dim via a static
 * opacity keyed off a disabled condition). Function-form `style` (`(state) => ...`) isn't
 * supported here — no current call site uses it, but it'd need its own resolution path if
 * one ever does. */
export const PressableScale = forwardRef<View, PressableProps>(function PressableScale({ onPressIn, onPressOut, style, ...props }, ref) {
  const progress = useSharedValue(0);
  const flattenedOpacity = typeof style === 'function' ? undefined : StyleSheet.flatten(style as StyleProp<ViewStyle>)?.opacity;
  const baseOpacity = typeof flattenedOpacity === 'number' ? flattenedOpacity : 1;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - progress.value * (1 - PRESSED_SCALE) }],
    opacity: baseOpacity * (1 - progress.value * (1 - PRESSED_OPACITY)),
  }));

  return (
    <AnimatedPressable
      ref={ref}
      onPressIn={(e) => {
        progress.value = withTiming(1, { duration: ANIM_DURATION_MS });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        progress.value = withTiming(0, { duration: ANIM_DURATION_MS });
        onPressOut?.(e);
      }}
      style={[style as never, animatedStyle]}
      {...props}
    />
  );
});
