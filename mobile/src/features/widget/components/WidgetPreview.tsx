import { useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import CityroamWidget from '@modules/cityroam-widget/src/CityroamWidget';
import { buildWidgetSnapshotJson } from '@/features/widget/widgetSync';
import { subscribeToWidgetAppearance } from '@/features/widget/widgetAppearance';
import { tripRecorder } from '@/features/rides/tripRecorder';
import { useColorScheme } from '@/components/useColorScheme';

// Matches the widget's 4x2 drop size (cityroam_widget_info.xml's targetCellWidth/Height),
// the shape most people will actually place it at.
const ASPECT_RATIO = 220 / 330;

/**
 * A live preview of the home-screen widget inside Settings, rendered through the exact
 * native code path the placed widget itself uses (CityroamWidget.renderPreview ->
 * WidgetRenderer.render) — not a second, hand-maintained JS approximation that could
 * silently drift from what the widget actually looks like on the home screen.
 *
 * Shows the real current data: a live ride while one is recording, the last completed
 * ride otherwise, the placeholder if neither exists yet — same as buildWidgetSnapshotJson
 * feeds the real widget. Re-renders on every widget appearance change (font/accent/
 * needle), every trip-recorder tick (so a live ride's speed/elapsed animates the same way
 * the placed widget does), and a system dark/light change.
 *
 * Renders nothing on failure — a dev client built without the widget module prebuilt has
 * no `renderPreview`, and a missing preview must never break the Settings screen around
 * it the way a thrown render error would.
 */
export function WidgetPreview() {
  const [width, setWidth] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  // Guards against a slow render resolving after a newer one already landed — renders
  // aren't guaranteed to resolve in the order they were requested.
  const generation = useRef(0);

  useEffect(() => {
    if (width <= 0) return;
    let cancelled = false;
    const height = width * ASPECT_RATIO;

    const render = () => {
      const myGeneration = ++generation.current;
      CityroamWidget.renderPreview(buildWidgetSnapshotJson(), width, height)
        .then((path) => {
          if (cancelled || myGeneration !== generation.current || !path) return;
          setUri(path);
        })
        .catch(() => {
          // No native module, or a render failure — the preview just doesn't show.
        });
    };

    render();
    const unsubscribeAppearance = subscribeToWidgetAppearance(render);
    const unsubscribeTrip = tripRecorder.subscribe(render);
    return () => {
      cancelled = true;
      unsubscribeAppearance();
      unsubscribeTrip();
    };
    // colorScheme has no direct effect on the call below, but system dark/light must
    // trigger a fresh render since the native renderer reads it itself.
  }, [width, colorScheme]);

  const height = width > 0 ? width * ASPECT_RATIO : 150;

  return (
    <View style={styles.container} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {uri && <Image key={uri} source={{ uri: `file://${uri}` }} style={{ width, height }} resizeMode="contain" />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', alignItems: 'center' },
});
