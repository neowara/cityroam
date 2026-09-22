import { type CSSProperties } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';

// Web stand-in for @react-native-community/slider — @react-native-community/slider
// has no reliable web build, so this wraps a plain <input type="range">
// covering the subset of props actually used in src/components/ui.
export type SliderProps = {
  style?: ViewStyle | ViewStyle[];
  minimumValue: number;
  maximumValue: number;
  step?: number;
  value: number;
  onValueChange: (value: number) => void;
  minimumTrackTintColor?: string;
  maximumTrackTintColor?: string;
  thumbTintColor?: string;
};

export function Slider({
  style,
  minimumValue,
  maximumValue,
  step = 1,
  value,
  onValueChange,
  minimumTrackTintColor = '#000',
  maximumTrackTintColor = '#ccc',
  thumbTintColor,
}: SliderProps) {
  const flatStyle = (StyleSheet.flatten(style) ?? {}) as CSSProperties;
  const pct = ((value - minimumValue) / Math.max(maximumValue - minimumValue, 1e-6)) * 100;

  return (
    <input
      type="range"
      min={minimumValue}
      max={maximumValue}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      style={{
        ...flatStyle,
        width: '100%',
        accentColor: thumbTintColor ?? minimumTrackTintColor,
        background: `linear-gradient(90deg, ${minimumTrackTintColor} ${pct}%, ${maximumTrackTintColor} ${pct}%)`,
      }}
    />
  );
}

export default Slider;
