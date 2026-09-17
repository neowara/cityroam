import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import { useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';

/** Shared card container (Matte/Glass style). Glass mode deliberately
 * avoids expo-blur's real hardware blur on Android: a BlurView whose blurTarget is its
 * own ancestor (true here, with multiple glass Cards sharing one BlurBackground)
 * crashes the native renderer via infinite RenderNode recursion — a flat tinted
 * surface + top sheen fakes the same visual read instead. */
// Layout properties that position a Card *among its siblings* rather than style its own
// content box. These must land on the outer BlurView in glass mode (below), not just
// glassInner — a margin/flex value on the inner view has nothing to push against since
// it has no siblings of its own, so it silently no-ops and adjacent Cards render with
// their borders touching (bug: glass-mode Cards had zero gap between them despite every
// caller passing a marginBottom).
const LAYOUT_STYLE_KEYS = [
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'marginHorizontal',
  'marginVertical',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'position',
  'top',
  'bottom',
  'left',
  'right',
] as const;

function splitLayoutStyle(style: ViewProps['style']): [object, object] {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const layout: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    if ((LAYOUT_STYLE_KEYS as readonly string[]).includes(key)) layout[key] = value;
    else rest[key] = value;
  }
  return [layout, rest];
}

export function Card({ style, ...props }: ViewProps) {
  const { containerStyle, accentColor } = useAppTheme();
  const colorScheme = useColorScheme();
  const borderColor = accentColor + '55';

  if (containerStyle === 'glass') {
    const [layoutStyle, contentStyle] = splitLayoutStyle(style);
    // Layout props (margin/width/flex/...) go on the outer wrapper so a caller's
    // spacing/sizing actually takes effect between Cards, matching Matte mode; the
    // rest (padding/gap/backgroundColor overrides) still land on glassInner where
    // children render.
    //
    // Android renders this through a plain View, not BlurView: blurMethod="none" already
    // means no real blur sampling happens there (GlassFill's tint + sheen is what actually
    // produces the look), so BlurView bought nothing on Android beyond being a native
    // PlatformView — and that PlatformView doesn't reliably reposition when its ScrollView
    // ancestor re-lays-out after a Card's content changes post-mount (e.g. an async
    // permission/status check resolving), leaving a stale opaque rectangle at the view's
    // old bounds while the real content renders shifted underneath it. iOS keeps BlurView
    // since blurMethod is an Android-only prop there — it still does a real hardware blur.
    const GlassContainer = Platform.OS === 'android' ? View : BlurView;
    const glassContainerProps = Platform.OS === 'android' ? {} : { intensity: 60, tint: colorScheme, blurMethod: 'none' as const };
    return (
      <GlassContainer {...glassContainerProps} style={[styles.card, styles.glassCard, { borderColor }, layoutStyle]}>
        <GlassFill />
        <View style={[styles.glassInner, contentStyle]} {...props} />
      </GlassContainer>
    );
  }

  return <View style={[styles.card, { borderColor }, style]} {...props} />;
}

/** Tint + top sheen alone, no outer shape — for applying the glass treatment to only
 * part of a container (e.g. Dashboard's "Last ride" text panel, not its map thumbnail). */
export function GlassFill() {
  const colorScheme = useColorScheme();
  return (
    <>
      <View style={[StyleSheet.absoluteFill, colorScheme === 'dark' ? styles.glassTintDark : styles.glassTintLight]} />
      {/* Fades to a small residual alpha, not 0 — on a tall card, 0 read as a plain flat panel at the bottom. */}
      <LinearGradient
        pointerEvents="none"
        colors={
          colorScheme === 'dark'
            ? ['rgba(255,255,255,0.16)', 'rgba(255,255,255,0.03)']
            : ['rgba(255,255,255,0.75)', 'rgba(255,255,255,0.1)']
        }
        style={styles.glassSheen}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.6, y: 1 }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 16,
    gap: 8,
    overflow: 'hidden',
  },
  glassCard: {
    padding: 0,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  glassTintLight: {
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  glassTintDark: {
    backgroundColor: 'rgba(20,20,24,0.42)',
  },
  // Pinned edges, not height: '100%' — percentage height resolves unreliably in Yoga against a content-driven (no explicit height) parent like BlurView.
  glassSheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  glassInner: {
    padding: 16,
    gap: 8,
    backgroundColor: 'transparent',
  },
});
