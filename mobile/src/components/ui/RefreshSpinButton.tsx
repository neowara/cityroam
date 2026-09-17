import { useEffect } from 'react';
import { Animated, Easing, StyleSheet, useAnimatedValue } from 'react-native';
import { RefreshCw } from 'lucide-react-native';

import { PressableScale } from '@/components/ui/PressableScale';

export function RefreshSpinButton({
  onPress,
  spinning,
  disabled,
  size = 12,
  color,
}: {
  onPress: () => void;
  spinning: boolean;
  disabled?: boolean;
  size?: number;
  color: string;
}) {
  const spin = useAnimatedValue(0);

  useEffect(() => {
    if (!spinning) return;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 700, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spinning, spin]);

  const spinDeg = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <PressableScale onPress={onPress} disabled={disabled || spinning} hitSlop={8} style={styles.button}>
      <Animated.View style={spinning ? { transform: [{ rotate: spinDeg }] } : undefined}>
        <RefreshCw size={size} color={color} />
      </Animated.View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: { opacity: 0.8 },
});
