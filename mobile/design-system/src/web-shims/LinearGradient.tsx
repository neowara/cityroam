import { View, type ViewProps } from 'react-native';

// Web stand-in for expo-linear-gradient — expo-linear-gradient has no
// react-native-web build, so this renders the same colors/start/end/locations
// API as a CSS linear-gradient background instead.
type Point = { x: number; y: number };

export type LinearGradientProps = ViewProps & {
  colors: string[];
  start?: Point;
  end?: Point;
  locations?: number[] | null;
};

function angleFor(start: Point, end: Point): number {
  // CSS gradient angles are measured clockwise from north; RN's start/end
  // points are measured in the 0-1 box from top-left, so flip Y before atan2.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const radians = Math.atan2(dx, -dy);
  return (radians * 180) / Math.PI;
}

export function LinearGradient({ colors, start = { x: 0.5, y: 0 }, end = { x: 0.5, y: 1 }, locations, style, ...props }: LinearGradientProps) {
  const stops = colors
    .map((color, i) => {
      const pct = locations?.[i] != null ? locations[i] * 100 : (i / Math.max(colors.length - 1, 1)) * 100;
      return `${color} ${pct}%`;
    })
    .join(', ');

  return (
    <View
      {...props}
      style={[
        style,
        {
          // @ts-expect-error — web-only CSS property, valid via react-native-web's style passthrough
          backgroundImage: `linear-gradient(${angleFor(start, end)}deg, ${stops})`,
        },
      ]}
    />
  );
}

export default LinearGradient;
