/**
 * Learn more about Light and Dark modes:
 * https://docs.expo.io/guides/color-schemes/
 */

import { StyleSheet, Text as DefaultText, View as DefaultView } from 'react-native';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { fontFamilyFor, letterSpacingFor, useAppTheme } from '@/lib/theme';

// A custom TTF has exactly one weight baked in — RN's `fontWeight` style doesn't
// reliably do anything on top of it on Android. Text below resolves a caller's
// fontWeight to the correct pre-built weight file, then drops it.
function weightBucket(fontWeight: unknown): 'regular' | 'medium' | 'bold' {
  if (fontWeight === 'bold' || (typeof fontWeight === 'string' && Number(fontWeight) >= 700)) return 'bold';
  if (typeof fontWeight === 'string' && Number(fontWeight) >= 500) return 'medium';
  return 'regular';
}

type ThemeProps = {
  lightColor?: string;
  darkColor?: string;
};

export type TextProps = ThemeProps & DefaultText['props'];
export type ViewProps = ThemeProps & DefaultView['props'];

export function useThemeColor(props: { light?: string; dark?: string }, colorName: keyof typeof Colors.light & keyof typeof Colors.dark) {
  const theme = useColorScheme() ?? 'light';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

export function Text(props: TextProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');
  // The chosen Appearance font applies to every themed Text automatically.
  const { font } = useAppTheme();
  const flat = StyleSheet.flatten(style) ?? {};
  const fontFamily = flat.fontFamily ?? fontFamilyFor(font, weightBucket(flat.fontWeight));
  // Applies theme.ts's LETTER_SPACING app-wide (was only reaching fontStyleFor() call sites before), respecting an explicit caller-set value.
  const letterSpacing = flat.letterSpacing ?? letterSpacingFor(font);

  return <DefaultText style={[{ color }, style, { fontFamily, letterSpacing, fontWeight: undefined }]} {...otherProps} />;
}

export function View(props: ViewProps) {
  const { style, lightColor, darkColor, ...otherProps } = props;
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return <DefaultView style={[{ backgroundColor }, style]} {...otherProps} />;
}
