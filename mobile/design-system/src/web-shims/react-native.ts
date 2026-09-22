// react-native-web doesn't export RN core's `useAnimatedValue` hook — this
// re-exports everything react-native-web has and adds the missing hook,
// matching RN's own implementation (a ref-stable Animated.Value).
import { useRef } from 'react';
import { Animated } from 'react-native-web';
// react-native-web ships no .d.ts of its own (see react-native-web.d.ts) — borrow
// the real react-native Animated type (API-compatible) just for the annotation.
import type { Animated as AnimatedType } from 'react-native';

export * from 'react-native-web';

export function useAnimatedValue(initialValue: number): AnimatedType.Value {
  const ref = useRef<AnimatedType.Value | null>(null);
  if (ref.current === null) ref.current = new Animated.Value(initialValue);
  return ref.current!;
}
