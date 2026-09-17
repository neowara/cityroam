import { useEffect } from 'react';
import { Animated, StyleSheet, View, useAnimatedValue } from 'react-native';

/** A small pulsing dot — active/connected/enabled status, matching the prototype's
 * "live" status-pill dot. A halo ring repeatedly expands and fades around a solid core. */
export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  const pulse = useAnimatedValue(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const opacity = pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.55, 0.1, 0] });

  // wrap sized to exactly `size` — the absolutely-positioned halo overflows past it (RN's default overflow:'visible'), not consuming flow layout space.
  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Animated.View
        style={[
          styles.halo,
          { backgroundColor: color, width: size, height: size, borderRadius: size / 2, transform: [{ scale }], opacity },
        ]}
      />
      <View style={[styles.core, { backgroundColor: color, width: size, height: size, borderRadius: size / 2 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute' },
  core: {},
});
