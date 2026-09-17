import { useEffect, useState } from 'react';
import { Animated, StyleSheet, View, useAnimatedValue, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

const SCROLL_PX_PER_SEC = 45;
// Pause at each end before scrolling again, same beat an airport departure-board
// sign holds a line before it starts moving.
const EDGE_PAUSE_MS = 1200;

/**
 * Single-line text that scrolls left to reveal what a fixed-width container can't
 * show all at once, instead of truncating with an ellipsis — for a banner where the
 * full message actually matters (e.g. which setting is missing) and there's no room
 * to wrap. Only animates when the text is actually wider than the space given; short
 * text just renders still, never scrolls unnecessarily.
 */
export function MarqueeText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const translateX = useAnimatedValue(0);
  const overflows = containerWidth > 0 && textWidth > containerWidth;

  useEffect(() => {
    translateX.stopAnimation();
    translateX.setValue(0);
    if (!overflows) return;
    const distance = textWidth - containerWidth;
    const duration = (distance / SCROLL_PX_PER_SEC) * 1000;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(EDGE_PAUSE_MS),
        Animated.timing(translateX, { toValue: -distance, duration, useNativeDriver: true }),
        Animated.delay(EDGE_PAUSE_MS),
        Animated.timing(translateX, { toValue: 0, duration, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [overflows, textWidth, containerWidth, translateX]);

  return (
    // `style` (e.g. the caller's `flex: 1`) is applied here too, not just on the Text
    // below — this View is the row child that actually needs to claim the available
    // width; a layout prop landing only on the Text inside would do nothing (its own
    // parent here defaults to column flexDirection, so `flex` there only affects
    // height, never width — width instead comes from `alignItems: 'flex-start'`
    // below, which is what lets the Text hug its true single-line content width
    // rather than being stretched or wrapped to fit).
    <View style={[styles.clip, style as StyleProp<ViewStyle>]} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
      <Animated.Text
        onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
        style={[style, styles.text, { transform: [{ translateX }] }]}>
        {children}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // flex: 1 (set by callers via the outer row) gives this its bounding width; the two
  // invisible clip edges the animation scrolls between ARE this box's own left/right
  // edges, offset from the neighboring icon/button by the row's own `gap`.
  clip: { overflow: 'hidden', alignItems: 'flex-start' },
  // No flex/flexShrink — hugs its own single-line intrinsic width (which can exceed
  // the clip box) rather than being stretched or wrapped to fit it, or textWidth would
  // never measure larger than the container and overflow could never be detected.
  text: { flexShrink: 0, includeFontPadding: false },
});
