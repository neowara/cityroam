import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, StyleSheet, Text, useAnimatedValue, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Settings2 } from 'lucide-react-native';

import { GlassFill } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { useDeviceQuickActions } from '@/features/device/components/useDeviceQuickActions';
import { useThemeColor } from '@/components/Themed';

import { tripRecorder } from '@/features/rides/tripRecorder';
import { useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';
import { useDeviceNoun } from '@/features/device/deviceNoun';

// How long a failed quick action's error stays visible before it clears itself —
// long enough to read, short enough not to linger over an otherwise-idle FAB.
const QUICK_ACTION_ERROR_MS = 4500;

const FAB_SIZE = 58;
const OPTION_SIZE = 48;
const OPTION_GAP = 8;
const EDGE_MARGIN = 18;
// Clearance above the dock (FloatingTabBar.tsx's `insets.bottom + 12` placement, ~60 tall).
const DOCK_HEIGHT_ESTIMATE = 60;
const GAP_ABOVE_DOCK = 14;
const ICON_HALO_SIZE = 28;

/** Pulsing accent halo + a continuously spinning wheel icon while a trip is
 * recording — the button's one clear "this is live" signal. Stops and resets the
 * instant recording stops, so it's never mid-animation when idle. */
function useRecordingAnimation(isActive: boolean) {
  const pulse = useAnimatedValue(0);
  const spin = useAnimatedValue(0);

  useEffect(() => {
    if (!isActive) return;
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    const spinLoop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    pulseLoop.start();
    spinLoop.start();
    return () => {
      pulseLoop.stop();
      spinLoop.stop();
      pulse.setValue(0);
      spin.setValue(0);
    };
  }, [isActive, pulse, spin]);

  return {
    haloScale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }),
    haloOpacity: pulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.55, 0.15, 0] }),
    spinDeg: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
  };
}

// Matches the entrance spring's settle time closely enough that the parent can safely
// unmount the menu once this elapses — same "revert" the appear animation already gets.
const OPTION_EXIT_MS = 220;

/** One satellite option (Tuya / Start Trip), fanning up from the main FAB with its own
 * staggered scale+fade entrance so the two cascade in rather than popping together, and
 * the same spring reversed on the way out (driven by `visible` rather than mount/unmount,
 * so the exit actually gets to play before the parent removes it from the tree). */
function OptionButton({
  icon,
  label,
  accentColor,
  isGlass,
  colorScheme,
  visible,
  delayMs,
  onPress,
  disabled,
  dimOnDisabled = true,
}: {
  icon: React.ReactNode;
  label: string;
  accentColor: string;
  isGlass: boolean;
  colorScheme: 'light' | 'dark';
  visible: boolean;
  delayMs: number;
  onPress: () => void;
  /** Blocks a second tap while a previous press's write is still in flight — a quick
   * control's write closure captures the board value at press time, so a rapid
   * double-tap before the board's echo re-renders would otherwise re-send the same
   * stale next-value twice instead of advancing again. */
  disabled?: boolean;
  /** Set false for a control whose icon must never look "off"/dimmed at all (the
   * headlight button — see HeadlightButtonIcon) — `disabled` still blocks the
   * double-tap, it just doesn't dim the icon while doing it, since the brief opacity
   * drop on every press read as a fake "off" state to a rider watching for one. */
  dimOnDisabled?: boolean;
}) {
  const anim = useAnimatedValue(0);

  useEffect(() => {
    Animated.spring(anim, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true,
      friction: 7,
      tension: 90,
      delay: visible ? delayMs : 0,
    }).start();
  }, [anim, visible, delayMs]);

  return (
    <Animated.View
      style={[
        styles.optionRow,
        {
          opacity: anim,
          transform: [{ scale: anim }, { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
        },
      ]}>
      <View
        style={[
          styles.optionLabelPill,
          { borderColor: accentColor + '55' },
          !isGlass && (colorScheme === 'dark' ? styles.matteDark : styles.matteLight),
        ]}>
        {isGlass && (
          <BlurView intensity={70} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill}>
            <GlassFill />
          </BlurView>
        )}
        <Text style={[styles.optionLabelText, { color: accentColor }]}>{label}</Text>
      </View>
      <PressableScale
        onPress={onPress}
        disabled={disabled}
        accessibilityLabel={label}
        hitSlop={8}
        style={[styles.optionButton, { borderColor: accentColor + '55' }, disabled && dimOnDisabled && styles.optionButtonDisabled]}
        android_ripple={{ color: accentColor + '55', borderless: false, radius: OPTION_SIZE / 2 }}>
        {isGlass ? (
          <BlurView intensity={70} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill}>
            <GlassFill />
            <View style={styles.optionFill}>{icon}</View>
          </BlurView>
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.optionFill, colorScheme === 'dark' ? styles.matteDark : styles.matteLight]}>
            {icon}
          </View>
        )}
      </PressableScale>
    </Animated.View>
  );
}

/** Quick access to board quick-controls and Board Settings. Start/End Trip moved to
 * the Dashboard (StartTripModule / LiveTripModule) — the FAB still shows a pulsing
 * halo while a manual trip is recording as an ambient "this is live" signal, it just
 * no longer offers the action itself. Board settings is always offered regardless of
 * pairing state — board-config.tsx already has its own "pair
 * a board first" empty state, no need to duplicate that check here. */
export default function FloatingTripButton() {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { accentColor: tint, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme();
  const isGlass = containerStyle === 'glass';

  const snapshot = useSyncExternalStore(tripRecorder.subscribe, tripRecorder.getSnapshot);
  // Keyed off 'manual' specifically, not any non-idle state — no manual stop/pulse for an auto-detected trip (surfaced on the Dashboard instead).
  const isManualActive = snapshot.state === 'manual';
  const activeColor = tint;
  const { haloScale, haloOpacity } = useRecordingAnimation(isManualActive);

  const [open, setOpen] = useState(false);
  // Stays true through the option buttons' own exit animation (see OPTION_EXIT_MS) —
  // without this, {open && <menu>} unmounts the moment `open` flips false and the
  // options just vanish instead of playing their reverse-of-entrance animation.
  const [menuMounted, setMenuMounted] = useState(false);
  // Mounts the moment the menu opens; unmounting waits for the options' exit animation.
  if (open && !menuMounted) setMenuMounted(true);
  const plusRotation = useAnimatedValue(0);

  // The connected device's own quick controls, from its profile
  // (src/features/device/deviceProfile.ts). Empty while disconnected, so the menu never
  // offers a control the device can't answer.
  const noun = useDeviceNoun();
  const quickActions = useDeviceQuickActions();
  const critColor = useThemeColor({}, 'crit');

  // A quick action's write can fail (the device refused it, or never answered) with
  // nothing telling the rider — the icon just reverts to its pre-press state, which
  // reads identically to "that press did nothing." Every quick-control hook already
  // tracks its own error (useDeviceWrite); this surfaces the newest one as a brief pill
  // near the FAB instead of swallowing it.
  const [actionError, setActionError] = useState<string | null>(null);
  const lastSeenErrors = useRef<Record<string, string | null>>({});
  const errorClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    for (const action of quickActions) {
      const previous = lastSeenErrors.current[action.key];
      if (action.error && action.error !== previous) {
        setActionError(action.error);
        if (errorClearTimer.current) clearTimeout(errorClearTimer.current);
        errorClearTimer.current = setTimeout(() => setActionError(null), QUICK_ACTION_ERROR_MS);
      }
      lastSeenErrors.current[action.key] = action.error;
    }
  }, [quickActions]);
  useEffect(
    () => () => {
      if (errorClearTimer.current) clearTimeout(errorClearTimer.current);
    },
    [],
  );

  useEffect(() => {
    Animated.spring(plusRotation, { toValue: open ? 1 : 0, useNativeDriver: true, friction: 8, tension: 100 }).start();
  }, [open, plusRotation]);

  useEffect(() => {
    if (open) return;
    const timer = setTimeout(() => setMenuMounted(false), OPTION_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (pathname.startsWith('/settings') || pathname.startsWith('/planner')) return null;

  const plusSpin = plusRotation.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] });

  return (
    <View
      style={[styles.wrap, { right: EDGE_MARGIN, bottom: insets.bottom + 12 + DOCK_HEIGHT_ESTIMATE + GAP_ABOVE_DOCK }]}
      pointerEvents="box-none">
      {actionError && (
        <View
          style={[styles.errorPill, { borderColor: critColor + '55' }, colorScheme === 'dark' ? styles.matteDark : styles.matteLight]}
          pointerEvents="none">
          <Text style={[styles.errorText, { color: critColor }]} numberOfLines={2}>
            {actionError}
          </Text>
        </View>
      )}
      {menuMounted && (
        <View style={styles.optionsStack} pointerEvents={open ? 'box-none' : 'none'}>
          <OptionButton
            icon={<Settings2 color={tint} size={18} />}
            label={`${noun.Cap} Settings`}
            accentColor={tint}
            isGlass={isGlass}
            colorScheme={colorScheme ?? 'light'}
            visible={open}
            delayMs={240}
            onPress={() => {
              setOpen(false);
              router.push('/device-settings');
            }}
          />
          {quickActions.map((action, index) => (
            <OptionButton
              key={action.key}
              icon={action.renderIcon(action.accentColor ?? tint, 18)}
              label={action.label}
              accentColor={action.accentColor ?? tint}
              isGlass={isGlass}
              colorScheme={colorScheme ?? 'light'}
              visible={open}
              // Staggered bottom-up, same cadence the hand-written list used.
              delayMs={Math.max(0, 200 - index * 40)}
              disabled={action.disabled}
              dimOnDisabled={action.dimOnDisabled}
              onPress={action.onPress}
            />
          ))}
        </View>
      )}
      <PressableScale
        onPress={() => setOpen((o) => !o)}
        accessibilityLabel={open ? 'Close quick actions' : 'Open quick actions'}
        hitSlop={10}
        style={[
          styles.fab,
          { borderColor: activeColor + '55' },
          isGlass ? styles.glassTab : colorScheme === 'dark' ? styles.matteDark : styles.matteLight,
        ]}
        android_ripple={{ color: activeColor + '55', borderless: false, radius: FAB_SIZE / 2 }}>
        {isGlass ? (
          <BlurView intensity={70} tint={colorScheme} blurMethod="none" style={StyleSheet.absoluteFill}>
            <GlassFill />
            <View style={styles.fabInner}>
              {isManualActive && (
                <Animated.View
                  pointerEvents="none"
                  style={[styles.halo, { backgroundColor: activeColor, transform: [{ scale: haloScale }], opacity: haloOpacity }]}
                />
              )}
              <Animated.View style={{ transform: [{ rotate: plusSpin }] }}>
                <Plus color={activeColor} size={24} />
              </Animated.View>
            </View>
          </BlurView>
        ) : (
          <View style={styles.fabInner}>
            {isManualActive && (
              <Animated.View
                pointerEvents="none"
                style={[styles.halo, { backgroundColor: activeColor, transform: [{ scale: haloScale }], opacity: haloOpacity }]}
              />
            )}
            <Animated.View style={{ transform: [{ rotate: plusSpin }] }}>
              <Plus color={activeColor} size={24} />
            </Animated.View>
          </View>
        )}
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    alignItems: 'flex-end',
  },
  optionsStack: {
    alignItems: 'flex-end',
    gap: OPTION_GAP,
    marginBottom: OPTION_GAP,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  optionLabelPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  optionLabelText: {
    fontSize: 12,
    fontWeight: '600',
  },
  errorPill: {
    maxWidth: 220,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  errorText: {
    fontSize: 12,
    fontWeight: '600',
  },
  optionButton: {
    width: OPTION_SIZE,
    height: OPTION_SIZE,
    borderRadius: OPTION_SIZE / 2,
    borderWidth: 1,
    // Ripple must be clipped by the SAME element it's attached to (the PressableScale
    // itself), not just a differently-shaped child — otherwise it spills past the
    // rounded corners as a visible rectangle on press.
    overflow: 'hidden',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  optionButtonDisabled: {
    opacity: 0.5,
  },
  optionFill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  fabInner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassTab: {
    backgroundColor: 'transparent',
  },
  matteLight: {
    backgroundColor: '#ffffff',
  },
  matteDark: {
    backgroundColor: '#1c1c22',
  },
  iconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: ICON_HALO_SIZE,
    height: ICON_HALO_SIZE,
    borderRadius: ICON_HALO_SIZE / 2,
  },
});
