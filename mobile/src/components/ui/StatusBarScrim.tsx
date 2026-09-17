import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Solid black regardless of theme (gradient/theme-colored versions were tried and
 * rejected), trimmed a few px shorter than the full inset. Must render as a sibling
 * *inside* the navigator boundary it needs to sit above — react-native-screens gives
 * each Stack.Screen its own native surface, so a plain RN sibling of the root Stack
 * won't paint over it regardless of zIndex.
 *
 * `elevation` (not just `zIndex`) is what actually achieves that on Android — but
 * elevation there also casts a Material drop shadow whose size scales with the
 * elevation value, and Material elevations are meant to stay in the 1-24 range. A
 * previous version of this used `elevation: 999` to "safely" out-rank every sibling,
 * which instead cast a shadow big enough to read as a solid dark rectangle bleeding
 * well below the scrim's own (intentionally thin) height — visible on every pushed
 * screen that renders this. Any positive elevation already out-ranks the default-0
 * siblings it needs to sit above; 1 is enough and keeps the shadow proportionate to
 * this view's actual size. */
export function StatusBarScrim() {
  const insets = useSafeAreaInsets();
  const height = Math.max(0, insets.top - 6);
  return <View pointerEvents="none" style={[styles.scrim, { height }]} />;
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    zIndex: 999,
    elevation: 1,
  },
});
