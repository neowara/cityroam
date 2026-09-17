import { useEffect, useState } from 'react';
import { Animated, useAnimatedValue } from 'react-native';
import { Flashlight, FlashlightOff } from 'lucide-react-native';

import { BLINK_HAPTIC_INTERVAL_MS, type HeadlightButtonMode, type HeadlightMode } from '@/features/device/boardQuickControls';

/** Renders the headlight the way the state actually looks: dark/default while off, a
 * filled/lit torch while static, and a torch that visibly flashes on and off while
 * blinking. "off" is real board-reported truth (dp8 raw `true`); "static" vs
 * "blinking" is a client-side memory of which press we're on (dp8 can't distinguish
 * them on reads — see boardQuickControls.ts). Only ever used for the dashboard's
 * read-only status badge, where a genuinely animated blink is the point — see
 * HeadlightButtonIcon for the interactive control, which deliberately does NOT
 * animate (see its own comment for why). */
export function HeadlightIcon({ mode, color, size = 18 }: { mode: HeadlightMode | null; color: string; size?: number }) {
  const blink = useAnimatedValue(1);

  useEffect(() => {
    if (mode !== 'blinking') {
      blink.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.2, duration: 350, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 350, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      blink.setValue(1);
    };
  }, [mode, blink]);

  if (mode == null || mode === 'off') return <FlashlightOff size={size} color={color} />;

  return (
    <Animated.View style={{ opacity: mode === 'blinking' ? blink : 1 }}>
      <Flashlight size={size} color={color} fill={color} />
    </Animated.View>
  );
}

/**
 * The FAB/device-settings interactive control's icon. Two hard constraints, both
 *:
 *
 * 1. Structurally cannot render the off-looking icon — `mode` only ever admits
 *    'static'/'blinking', never 'off' or null, since only the board's own physical
 *    power button can turn the light fully off (see useHeadlightControl).
 * 2. NEVER dims via opacity, even for 'blinking'. HeadlightIcon's periodic opacity
 *    pulse (full brightness -> 20% -> full, on a loop) is exactly right for the
 *    dashboard's passive status badge, but on this interactive button it was mistaken
 *    for the icon "rotating to a third, grayed-out state" — a real, repeated point of
 *    confusion, not a one-off. Blinking is instead shown by toggling the fill itself
 *    solid <-> empty (outline only) at the same cadence as the blink haptic
 *    (BLINK_HAPTIC_INTERVAL_MS, shared from boardQuickControls.ts so the visual flash
 *    and the buzz land together) — full brightness and full color at every frame,
 *    never a dimmed one.
 */
export function HeadlightButtonIcon({ mode, color, size = 18 }: { mode: HeadlightButtonMode; color: string; size?: number }) {
  const [solid, setSolid] = useState(true);

  useEffect(() => {
    if (mode !== 'blinking') {
      setSolid(true);
      return;
    }
    setSolid(false);
    const interval = setInterval(() => setSolid((s) => !s), BLINK_HAPTIC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [mode]);

  const filled = mode === 'static' || solid;
  return <Flashlight size={size} color={color} fill={filled ? color : 'none'} />;
}
