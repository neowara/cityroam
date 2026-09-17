import { useEffect, type ReactNode } from 'react';
import Animated, { useSharedValue, useAnimatedStyle, withDelay, withTiming, Easing } from 'react-native-reanimated';

const STAGGER_MS = 70;
const DURATION_MS = 240;
const SLIDE_UP_PX = 16;

/** Fade-in + slight slide-up, staggered by `index` — "top-to-bottom,
 * once, on first app launch" entrance. `enabled` gates whether this instance
 * actually animates at all: the caller (Dashboard) decides that once per app
 * session via a module-level flag, not per mount of this component, so every
 * module in the same reveal pass agrees on whether to animate. When `enabled` is
 * false, content just renders at its final resting state immediately — no
 * animated mount cost on every screen focus/navigation. */
export function StaggerReveal({ index, enabled, children }: { index: number; enabled: boolean; children: ReactNode }) {
  const opacity = useSharedValue(enabled ? 0 : 1);
  const translateY = useSharedValue(enabled ? SLIDE_UP_PX : 0);

  useEffect(() => {
    if (!enabled) return;
    const delay = index * STAGGER_MS;
    opacity.value = withDelay(delay, withTiming(1, { duration: DURATION_MS, easing: Easing.out(Easing.cubic) }));
    translateY.value = withDelay(delay, withTiming(0, { duration: DURATION_MS, easing: Easing.out(Easing.cubic) }));
    // Runs once per mount — `enabled` is fixed for the lifetime of this instance
    // (the caller only ever passes a stable, session-scoped value).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return <Animated.View style={animatedStyle}>{children}</Animated.View>;
}
