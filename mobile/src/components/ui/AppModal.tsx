import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  useAnimatedValue,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { Card } from '@/components/ui/Card';
import { useThemeColor } from '@/components/Themed';
import { useAppTheme } from '@/lib/theme';

// Height of the bottom scroll-fade hint (see the ScrollView wrapper's own comment).
const FADE_HEIGHT = 28;

// Matches the fade timing every existing `Modal animationType="fade"` usage already
// had (RN's own default), so swapping over doesn't change how quickly a modal shows
// up — only *how* it animates in (backdrop fade + content scale/slide instead of RN's
// flat cross-fade) and how the container looks (Card's Appearance-aware styling
// instead of each call site's own ad hoc `{ backgroundColor: surface }` box).
const FADE_MS = 200;
const EXIT_MS = 150;
// Cap the card dialog at 80% of the keyboard-avoided screen height. Below the cap the
// Card grows to fit its content; past it the content ScrollView (always mounted, see
// the render comment) stops growing and scrolls instead. A percentage is deliberate —
// it resolves against cardWrap's definite height (flex: 1), which itself shrinks with
// the keyboard, so the cap always tracks the space actually left for the dialog
// instead of a fixed pixel amount.
const MAX_HEIGHT_RATIO = 0.8;
// styles.card's own paddingVertical (20 top + 20 bottom) — not measurable via onLayout
// the way the chrome/footer/content Views are, so it's a literal constant kept next to
// the style it mirrors rather than re-derived at runtime.
const CARD_VERTICAL_PADDING = 40;

type AppModalProps = {
  visible: boolean;
  onRequestClose: () => void;
  children: ReactNode;
  /** Extra style merged onto the Card container (e.g. a caller's own `maxHeight`/`gap`). */
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Rendered as a sibling below the scrollable content, inside the Card — stays put
   * while `children` scrolls instead of being carried off-screen with it. For a
   * primary action (a form's submit button) that must stay reachable regardless of
   * how tall the scrollable content grows or how much the keyboard eats into the
   * available height.
   */
  footer?: ReactNode;
  /**
   * Rendered as a sibling above the scrollable content, inside the Card — stays put
   * while `children` scrolls, same reasoning as `footer`. For a title/intro that
   * should stay visible as a heading rather than scrolling away with the first item
   * (a checklist's "what is this" framing shouldn't disappear the moment the rider
   * scrolls to read item 3).
   */
  header?: ReactNode;
  /**
   * 'card' (default): dimmed backdrop + a centered Card, matching every existing
   * dialog-style modal in the app (confirm/error/pairing/etc).
   * 'fullScreen': content fills the screen against the theme surface color, no
   * backdrop/card — for board-config.tsx's "writing to the board right now" modal,
   * which was already full-bleed, not a floating dialog.
   */
  variant?: 'card' | 'fullScreen';
  /**
   * None of the Modal usages this replaced dismissed on backdrop tap (only
   * onRequestClose / an explicit Cancel button did) — default false to preserve that
   * exact behavior.
   */
  dismissOnBackdropPress?: boolean;
  /**
   * Render a close "X" in the card's top-right corner that calls onRequestClose, so
   * every dialog has an obvious, gesture-free way out instead of relying on the
   * Android back button / swipe (the "no close button at all" complaint). Defaults to
   * true for 'card'; false for 'fullScreen', whose one current usage (board-config's
   * "writing to the board right now") is deliberately non-dismissible while it runs.
   * Pass false on a card dialog that already renders its own explicit Cancel/Close
   * control if you'd rather not have both.
   */
  showCloseButton?: boolean;
};

/** Shared modal shell — every screen that used to reach for React Native's
 * built-in `Modal` directly now goes through this instead, so entrance/exit animation,
 * backdrop treatment, and container styling (Card's glass/matte + accent-color
 * Appearance system) are consistent app-wide rather than each modal rolling its own
 * (and getting Android's generic default modal transition in the process). Built on
 * RN's own `Animated` API, matching the house style already used by
 * FloatingTripButton/StatusDot rather than introducing Reanimated as a new dependency. */
export function AppModal({
  visible,
  onRequestClose,
  children,
  contentStyle,
  footer,
  header,
  variant = 'card',
  dismissOnBackdropPress = false,
  showCloseButton = variant === 'card',
}: AppModalProps) {
  const surface = useThemeColor({}, 'surface');
  const inkDim = useThemeColor({}, 'inkDim');
  const { containerStyle } = useAppTheme();
  // Card's matte mode deliberately sets no backgroundColor (it relies on the screen's
  // own background showing through for normal in-page cards) — fine on a page, but
  // as a floating dialog over a dimmed backdrop that reads as a see-through, outline-only
  // box. Glass mode already achieves real opacity via its own BlurView/tint (GlassFill),
  // so only matte needs this explicit fill.
  const matteCardBackground = containerStyle === 'glass' ? undefined : { backgroundColor: surface };
  // Stays true through the exit animation — RN's Modal itself has no concept of an
  // "animating out" state, so this keeps it mounted a beat after `visible` goes false.
  const [mounted, setMounted] = useState(visible);
  const progress = useAnimatedValue(0);
  // Measured from a plain View wrapping the actual content inside the ScrollView — it
  // drives both the overflow decision and, below the cap, the ScrollView's own height
  // (see the render comment for why the height is always a literal pixel value).
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // cardWrap's own onLayout — flex:1 gives it a definite height, which scrollCapPx below
  // resolves the 80% cap against.
  const [wrapHeight, setWrapHeight] = useState<number | null>(null);
  // The close button row, `header`, and `footer` all sit outside the ScrollView but
  // inside the same Card — capping the ScrollView at 80% of wrapHeight without
  // accounting for their height let the Card's *total* height exceed wrapHeight on a
  // tall header/footer combination, pushing the footer off the bottom of the screen
  // with nothing left to scroll it into view (a bug: a dialog with a long header
  // and a footer button — Direct BLE's sign-in form — hid its own submit button this
  // way). Measured so the two can be subtracted before applying the ratio cap, and the
  // whole Card is guaranteed to actually fit within wrapHeight.
  const [chromeHeight, setChromeHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  // footer is often conditional per-render (e.g. only shown on one step of a
  // multi-step dialog) — its View unmounts rather than reporting a fresh onLayout of
  // 0, so the raw state can go stale at the last-measured height. Reading `footer`
  // itself here avoids budgeting space for a footer that isn't actually rendered.
  const effectiveFooterHeight = footer != null ? footerHeight : 0;
  const scrollCapPx =
    wrapHeight != null
      ? Math.max(0, Math.min(wrapHeight * MAX_HEIGHT_RATIO, wrapHeight - chromeHeight - effectiveFooterHeight - CARD_VERTICAL_PADDING))
      : undefined;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, { toValue: 1, duration: FADE_MS, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(progress, { toValue: 0, duration: EXIT_MS, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    // `mounted` is intentionally excluded — including it would re-run (and restart)
    // the entrance animation once `setMounted(true)` above lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, progress]);

  if (!mounted) return null;

  // contentOverflows decides only the scroll-indicator visibility now that the
  // ScrollView is always mounted (see the render comment for why the old branch-swap
  // had to go). Epsilon guards against sub-pixel rounding flashing a bar on exact fit.
  const contentOverflows = contentHeight != null && scrollCapPx != null && contentHeight > scrollCapPx + 1;
  // Undefined only on the very first layout pass (before the inner View's onLayout
  // reports). Every frame after that the height is a literal pixel value — see the
  // render comment for why the height can never come from a percentage/flex.
  const scrollHeight = contentHeight != null && scrollCapPx != null ? Math.min(contentHeight, scrollCapPx) : undefined;

  const backdropOpacity = progress;
  const contentOpacity = progress;
  const contentScale = progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] });
  const contentTranslateY = progress.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onRequestClose} statusBarTranslucent>
      {/* RN's Modal renders in its own native window on Android, so it never gets the
          automatic keyboard resize a regular screen gets from windowSoftInputMode --
          without this, a TextInput inside a modal (DeviceNameRow, NumberFieldRow) can
          end up hidden behind the keyboard with no way to see what's being typed.
          'height' shrinks the modal's own layout instead of padding/translating it,
          which reads correctly against a centered dialog. */}
      <KeyboardAvoidingView behavior="height" style={styles.keyboardAvoider}>
        {variant === 'fullScreen' ? (
          <Animated.View style={[styles.fullScreen, { backgroundColor: surface, opacity: contentOpacity }]}>
            <ScrollView contentContainerStyle={styles.fullScreenScrollContent} showsVerticalScrollIndicator>
              {children}
            </ScrollView>
          </Animated.View>
        ) : (
          <>
            <Pressable
              style={StyleSheet.absoluteFill}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onPress={dismissOnBackdropPress ? onRequestClose : undefined}>
              <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropOpacity }]} />
            </Pressable>
            <Animated.View style={styles.centerWrap} pointerEvents="box-none">
              <Animated.View
                onLayout={(e) => setWrapHeight(e.nativeEvent.layout.height)}
                style={[
                  styles.cardWrap,
                  { opacity: contentOpacity, transform: [{ scale: contentScale }, { translateY: contentTranslateY }] },
                ]}>
                {/* Content lives in ONE always-mounted ScrollView — never swap it for a
                    plain View based on measurement. A branch swap remounts every child,
                    which threw away TextInput focus mid-typing; with the keyboard open
                    the remount closed the keyboard, changed the available height, flipped
                    the branch back, and the modal looped: scroll jumping, keyboard
                    impossible to keep open. Height stays unset for the first layout pass
                    only — rendering nothing instead would deadlock (no mounted View means
                    no onLayout, so contentHeight could never arrive). An unset-height
                    ScrollView hug-sizes like a plain View, so that first pass IS the
                    measurement pass, and no child ever remounts. From then on the height
                    is a literal pixel value: measured content height below the cap (so
                    short content hugs like a plain View would), the cap itself above. */}
                <Card style={[styles.card, matteCardBackground, contentStyle]}>
                  {/* Measured as one block — its height comes out of wrapHeight's budget
                      before the scroll cap below is computed, the same way footerHeight
                      does (see scrollCapPx's own comment for why). */}
                  <View onLayout={(e) => setChromeHeight(e.nativeEvent.layout.height)}>
                    {showCloseButton && (
                      <View style={styles.closeHeader}>
                        <Pressable
                          onPress={onRequestClose}
                          hitSlop={10}
                          style={styles.closeButton}
                          android_ripple={{ color: inkDim + '22', borderless: true }}
                          accessibilityRole="button"
                          accessibilityLabel="Close dialog">
                          <X size={18} color={inkDim} />
                        </Pressable>
                      </View>
                    )}
                    {header != null && <View style={styles.header}>{header}</View>}
                  </View>
                  {/* Wrapped so the bottom fade positions against the scroll region alone,
                      not the whole Card — it must never cover the header or footer. */}
                  <View style={styles.scrollWrap}>
                    <ScrollView
                      style={[styles.cardScroll, scrollHeight != null ? { height: scrollHeight } : null]}
                      showsVerticalScrollIndicator={contentOverflows}
                      contentContainerStyle={styles.cardScrollContent}>
                      <View
                        onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
                        style={[styles.cardScrollContent, { alignSelf: 'stretch' }]}>
                        {children}
                      </View>
                    </ScrollView>
                    {/* Hints that there's more to scroll to — shown purely from the
                        overflow measurement, not live scroll position (RN's onScroll
                        fires too coarsely to track "at the very bottom" without jank), so
                        it stays up the whole time content overflows rather than trying to
                        disappear right at the last pixel. */}
                    {contentOverflows && (
                      <LinearGradient pointerEvents="none" colors={['transparent', surface]} style={styles.scrollFade} />
                    )}
                  </View>
                  {footer != null && (
                    <View style={styles.footer} onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>
                      {footer}
                    </View>
                  )}
                </Card>
              </Animated.View>
            </Animated.View>
          </>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  // flex:1 gives cardWrap a definite height (it fills the keyboard-avoided screen),
  // measured via onLayout above to compute the ScrollView's literal-pixel maxHeight cap.
  cardWrap: {
    flex: 1,
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The Card fills the cardWrap (width: '100%', maxWidth: 440) so a dialog always has a
  // sensible width regardless of its content. Without this the Card shrank to its content
  // width, and content with no intrinsic width (e.g. a ScrollView list of options, like
  // SelectField's dropdown) collapsed to a sliver. Height still adapts to content via the
  // scrollCapPx logic above.
  card: {
    width: '100%',
    padding: 20,
  },
  // Empty by default — the literal-pixel height applied inline (scrollHeight) is what
  // caps growth; see wrapHeight's declaration above for why this can't be a static
  // percentage/flex value in the stylesheet.
  cardScroll: {},
  // Gives the fade below something definite to position `absolute` against — without
  // it, `absolute` would resolve against the whole Card and could cover the header.
  scrollWrap: { alignSelf: 'stretch' },
  scrollFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: FADE_HEIGHT,
  },
  // In-flow, not absolute — same reasoning as footer below: reserves its own space so
  // the scroll region can never grow underneath it, and never scrolls away itself.
  header: {
    width: '100%',
    marginBottom: 4,
  },
  // Children center on the cross axis by default so dialog content (leading icon,
  // title, body) lines up down the middle — the "are you sure"/notice look. Anything
  // that genuinely needs the Card's full width opts in with its own alignSelf:
  // 'stretch' (option lists, full-width confirm buttons, form input rows), which
  // overrides this per-child. A container-level alignItems: 'stretch' would fix a
  // stretch-needing child, but it also left-aligns every fixed-size leading icon
  // (WifiOff/AlertTriangle/Square/...), which reads as broken on every dialog.
  // Centering is the correct default; stretch is opt-in per child.
  cardScrollContent: {
    alignItems: 'center',
    gap: 10,
  },
  // In-flow (not absolute) so the X reserves its own space and can never sit on top of
  // centered dialog content; as a sibling of the ScrollView it stays pinned in the
  // corner while the content scrolls beneath it.
  closeHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyboardAvoider: {
    flex: 1,
  },
  // In-flow, not absolute — same reasoning as closeHeader: reserves its own space so
  // it can never overlap the last bit of scrollable content, and stays a fixed sibling
  // of the ScrollView rather than something that could itself scroll away.
  footer: {
    width: '100%',
    marginTop: 10,
  },
  fullScreen: {
    flex: 1,
  },
  fullScreenScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
  },
});
