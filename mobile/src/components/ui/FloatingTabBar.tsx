import { useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
// SDK 56+: app code can't import @react-navigation/* directly — expo-router vendors
// its own copy internally and re-exports the types from expo-router/tabs instead.
import type { BottomTabBarProps } from 'expo-router/tabs';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/Themed';
import { GlassFill } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';

/**
 * Replaces expo-router's default flat, edge-to-edge tab bar with a floating "dock" —
 * inset from the screen edges, pill-shaped, elevated over content — per the Liquid
 * Glass reference the user supplied. Glass mode never uses expo-blur's real hardware
 * blur on Android — see the long comment in Card.tsx for why (reproduced live: a
 * native RenderThread stack overflow from a self-referencing blur target). A flat
 * tinted pill + top sheen instead; Matte mode is a fully solid pill.
 */
export function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { containerStyle, accentColor } = useAppTheme();
  const colorScheme = useColorScheme();
  const isGlass = containerStyle === 'glass';

  const dock = (
    <View style={styles.row}>
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === index;
        const color = isFocused ? accentColor : colorScheme === 'dark' ? '#9a9aa2' : '#6b6b74';

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <PressableScale
            key={route.key}
            onPress={onPress}
            style={styles.tab}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}>
            <TabPulse focused={isFocused}>
              {options.tabBarIcon?.({ color, size: 22, focused: isFocused })}
              <Text style={[styles.label, { color }]}>{String(options.title ?? route.name)}</Text>
            </TabPulse>
          </PressableScale>
        );
      })}
    </View>
  );

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
      {isGlass ? (
        <BlurView
          intensity={70}
          tint={colorScheme}
          blurMethod="none"
          style={[styles.dock, styles.glassDock, { borderColor: accentColor + '40' }]}>
          {/* Shared with every other glass surface (Card.tsx, FloatingTripButton) —
              used to be its own duplicated tint+sheen copy here, which is exactly how
              a real gradient-height bug fix once landed in Card.tsx but not here.
              One implementation now, so a fix can't drift out of sync again. */}
          <GlassFill />
          {dock}
        </BlurView>
      ) : (
        <View style={[styles.dock, colorScheme === 'dark' ? styles.matteDark : styles.matteLight, { borderColor: accentColor + '40' }]}>
          {dock}
        </View>
      )}
    </View>
  );
}

const PULSE_UP_SCALE = 1.15;
const PULSE_UP_MS = 90;
const PULSE_SETTLE_MS = 140;

/** Small "settle" pulse (1 -> 1.15 -> 1.0) on the icon+label when a tab BECOMES the
 * focused one — "nothing dramatic" framing. Skips the pulse on this
 * tab's own initial mount (a `useRef` first-render guard, not a `useEffect` with
 * `focused` in deps alone, since that would still fire on mount) so the
 * default-focused first tab doesn't pulse immediately at app launch. */
function TabPulse({ focused, children }: { focused: boolean; children: ReactNode }) {
  const scale = useSharedValue(1);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (focused) {
      scale.value = withSequence(withTiming(PULSE_UP_SCALE, { duration: PULSE_UP_MS }), withTiming(1, { duration: PULSE_SETTLE_MS }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return <Animated.View style={[styles.tabPulse, animatedStyle]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  dock: {
    flexDirection: 'row',
    borderRadius: 28,
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  glassDock: {
    backgroundColor: 'transparent',
  },
  matteLight: {
    backgroundColor: '#ffffff',
  },
  matteDark: {
    backgroundColor: '#1c1c22',
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 4,
    minWidth: 64,
  },
  tabPulse: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  label: {
    fontSize: 11,
  },
});
