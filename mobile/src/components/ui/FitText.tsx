import { Text, type TextProps } from '@/components/Themed';

/**
 * Thin wrapper around the themed `Text` that shrinks-to-fit instead of overflowing/
 * clipping when a metric-heavy font choice (Mono's wide fixed-width glyphs, or the
 * ClashDisplay_Bold headers face from lib/theme.tsx's `fontStyleFor`) doesn't fit text
 * sized for the default proportional fonts (SpaceGrotesk/Manrope). Uses RN's own built-in
 * `adjustsFontSizeToFit` + `numberOfLines` mechanism (supported on both iOS and
 * Android) instead of another round of hand-tuned per-font letter-spacing constants
 * that only partially work and have to be re-tuned every time a new metric-heavy font
 * is added.
 *
 * `minimumFontScale` default of 0.7 is sized to the worst realistic case actually in
 * this app: a StatTile value like "12.34 km/%" set in SpaceMono measures ~30% wider
 * than the same string in the default SpaceGrotesk — mono's fixed-width glyph cells
 * cost the most on narrow proportional characters ('.', '/', '%', ' ') that are cheap
 * in a proportional font but pay for a full character cell in mono. Scaling down to
 * ~0.7 is what it actually takes to keep that specific worst case from still
 * overflowing; much higher and it doesn't fully solve the bug, much lower and a stat
 * value stops being legible. These defaults are fixed — every call site in the app
 * needs the same fit-to-width behavior, so no per-site override knobs are exposed.
 *
 * Nested `Text` children (e.g. a value + a smaller inline unit label) are handled
 * correctly for free — both RN Android/iOS renderers measure the whole nested-Text
 * tree as a single attributed string and apply one uniform shrink factor across it,
 * not just the outer Text's own run.
 */
export function FitText({ style, ...props }: TextProps) {
  return <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={style} {...props} />;
}
