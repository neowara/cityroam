import { View, type ViewProps } from 'react-native';

// Web stand-in for expo-blur's BlurView — approximates the native glass effect
// with a CSS backdrop-filter since expo-blur has no react-native-web build.
export type BlurTint = 'light' | 'dark' | 'default' | 'systemMaterial' | string;

export type BlurViewProps = ViewProps & {
  intensity?: number;
  tint?: BlurTint;
  blurMethod?: string;
};

const TINT_BACKGROUND: Record<string, string> = {
  light: 'rgba(255, 255, 255, 0.55)',
  dark: 'rgba(10, 12, 16, 0.55)',
  default: 'rgba(255, 255, 255, 0.35)',
};

export function BlurView({ intensity = 40, tint = 'default', blurMethod: _blurMethod, style, ...props }: BlurViewProps) {
  const blurPx = Math.max(0, Math.round((intensity / 100) * 24));
  const background = TINT_BACKGROUND[tint] ?? TINT_BACKGROUND.default;

  return (
    <View
      {...props}
      style={[
        style,
        {
          backgroundColor: background,
          // @ts-expect-error — web-only CSS property, valid via react-native-web's style passthrough
          backdropFilter: `blur(${blurPx}px)`,
          WebkitBackdropFilter: `blur(${blurPx}px)`,
        },
      ]}
    />
  );
}

export default BlurView;
