import { useEffect, useState } from 'react';
import { Animated, StyleSheet, useAnimatedValue, View } from 'react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { humanizeEnumValue } from '@/features/device/boardValue';

/** iOS-style segmented toggle with a sliding highlight instead of a static row of
 * chips. Options lay out evenly; the highlight animates to whichever one is
 * selected instead of just swapping colors. */
export function SegmentedControl({
  options,
  value,
  onChange,
  accentColor,
  inkDim,
  text,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  accentColor: string;
  inkDim: string;
  text: string;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const thumbX = useAnimatedValue(0);
  const selectedIndex = Math.max(0, options.indexOf(value));
  const segmentWidth = trackWidth / options.length;

  useEffect(() => {
    if (trackWidth === 0) return;
    Animated.spring(thumbX, { toValue: selectedIndex * segmentWidth, useNativeDriver: true, friction: 9, tension: 120 }).start();
  }, [selectedIndex, segmentWidth, trackWidth, thumbX]);

  return (
    <View style={[styles.segmentTrack, { borderColor: inkDim + '33' }]} onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}>
      {trackWidth > 0 && (
        <Animated.View
          style={[styles.segmentThumb, { width: segmentWidth, backgroundColor: accentColor, transform: [{ translateX: thumbX }] }]}
        />
      )}
      {options.map((opt) => {
        const selected = opt === value;
        return (
          <PressableScale key={opt} style={styles.segmentOption} onPress={() => onChange(opt)}>
            <Text style={[styles.segmentText, { color: selected ? '#fff' : text }]}>{humanizeEnumValue(opt)}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segmentTrack: { flexDirection: 'row', height: 36, borderRadius: 10, borderWidth: 1, marginTop: 2, marginBottom: 6, overflow: 'hidden' },
  segmentThumb: { position: 'absolute', top: 0, bottom: 0, left: 0, borderRadius: 9 },
  segmentOption: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: 13, fontWeight: '700' },
});
