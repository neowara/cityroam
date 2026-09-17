import { useEffect } from 'react';
import { Animated, StyleSheet, View, useAnimatedValue } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { BatteryFull, BatteryLow, BatteryMedium, Bike, Gauge, Lock, LockOpen, Route } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { DeviceNameText } from '@/features/device/components/DeviceNameText';
import { HeadlightIcon } from '@/features/device/components/HeadlightIcon';
import { modeColor } from '@/components/ui/ModeChip';
import { MODE_ICONS } from '@/lib/mode';
import { useHeadlightStatus } from '@/features/device/boardQuickControls';
import { useActiveDeviceBrand, useBleRawDps } from '@/features/device/deviceLink';
import { DEFAULT_BRAND, type BoardSnapshot } from '@/lib/api';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { profileForBrand } from '@/features/device/deviceProfile';

// Fixed 0-30/31-60/61-100 red/yellow/green banding — neither device exposes its own low-battery level over BLE.
function batteryColor(pct: number | null, good: string, warn: string, crit: string, fallback: string): string {
  if (pct == null) return fallback;
  if (pct <= 30) return crit;
  if (pct <= 60) return warn;
  return good;
}

// Same bands as batteryColor — a genuinely low/half/full-looking glyph per band, not one recolored icon.
function batteryIcon(pct: number | null): typeof BatteryFull {
  if (pct == null || pct <= 30) return BatteryLow;
  if (pct <= 60) return BatteryMedium;
  return BatteryFull;
}

const STAGGER_MS = 90;

/** One badge's entrance: a staggered spring bounce-in plus a brief colored glow ring
 * around its border, so a rider's eye is drawn to each status the instant the board
 * actually connects — never played for a badge that was already showing, since this
 * whole row unmounts entirely while offline and remounts fresh on every reconnect. */
function EntranceBadge({ index, glowColor, children }: { index: number; glowColor: string; children: React.ReactNode }) {
  const progress = useAnimatedValue(0);
  const glow = useAnimatedValue(0);

  useEffect(() => {
    const delay = index * STAGGER_MS;
    Animated.spring(progress, { toValue: 1, useNativeDriver: true, friction: 6, tension: 80, delay }).start();
    Animated.sequence([
      Animated.delay(delay + 120),
      Animated.timing(glow, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0, duration: 550, useNativeDriver: true }),
    ]).start();
    // Runs once per mount — this component only ever mounts fresh (see the comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View style={{ opacity: progress, transform: [{ scale: progress }] }}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.glowRing, { borderColor: glowColor, opacity: glow }]} />
      {children}
    </Animated.View>
  );
}

/**
 * Device name + battery + status badges, shown only while a device is genuinely
 * connected. Every value here comes straight from the live snapshot/hooks passed in —
 * nothing is faked or held over from before a disconnect, and the whole row disappears
 * the instant the board isn't reporting rather than showing a stale or neutral-looking
 * placeholder.
 */
export function DeviceStatusHeader({ online, snapshot }: { online: boolean | null; snapshot: BoardSnapshot | undefined }) {
  const tint = useThemeColor({}, 'tint');
  const surface = useThemeColor({}, 'surface');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const good = useThemeColor({}, 'good');
  const warn = useThemeColor({}, 'warn');
  const crit = useThemeColor({}, 'crit');
  const noun = useDeviceNoun();
  const brand = useActiveDeviceBrand();
  const headlightStatus = useHeadlightStatus();

  // Mode and lock come from the brand-agnostic snapshot (a NAVEE's are translated
  // natively into the same fields), so they show for every brand. The headlight badge
  // reads a Tuya datapoint directly and only means anything on a Tynee board.
  const showTuyaStatus = brand === DEFAULT_BRAND;
  // Pills beyond battery/mode/lock come from the device's profile: readings the
  // brand-neutral snapshot has no field for (a NAVEE's own range estimate and cruise).
  const profile = profileForBrand(brand);
  const rawDps = useBleRawDps();
  const rangeKm =
    profile.statusExtras.includes('rangeKm') && typeof rawDps?.['navee.remainingKm'] === 'number'
      ? (rawDps['navee.remainingKm'] as number)
      : null;
  const cruiseOn = profile.statusExtras.includes('cruise') && rawDps?.cruise === 1;

  if (online !== true) return null;

  const BoardBatteryIcon = batteryIcon(snapshot?.batteryPct ?? null);
  const RemoteBatteryIcon = batteryIcon(snapshot?.remoteBatteryPct ?? null);
  const boardBatteryColor = batteryColor(snapshot?.batteryPct ?? null, good, warn, crit, inkDim);
  const remoteBatteryColor = batteryColor(snapshot?.remoteBatteryPct ?? null, good, warn, crit, inkDim);
  const modeStatusColor = snapshot?.mode ? modeColor(snapshot.mode, false) : inkFaint;
  const lockStatusColor = snapshot?.lockOn == null ? inkFaint : snapshot.lockOn ? warn : inkDim;

  // Each badge only enters the list once its own data is actually ready — mounting a
  // badge in a "no data yet" placeholder state and re-rendering it moments later with
  // real numbers defeats the point of the entrance animation below (and looks like a
  // glitch, not an entrance). The board's own dps arrive individually and slightly
  // staggered in practice, so badges pop in one at a time as their data lands rather
  // than all appearing together half-empty. `key` identifies which fact each badge is
  // about — not array position, so a later-arriving badge doesn't reflow/reindex the
  // ones already showing.
  const badges: { key: string; glowColor: string; content: React.ReactNode }[] = [];

  if (snapshot?.batteryPct != null) {
    badges.push({
      key: 'battery',
      glowColor: boardBatteryColor,
      content: (
        <View style={[styles.batteryBadge, { backgroundColor: surface, borderColor: tint + '55' }]}>
          <MaterialCommunityIcons name={profile.deviceIcon} size={13} color={tint} />
          <Text style={[styles.batteryBadgeText, { color: boardBatteryColor }]}>{snapshot.batteryPct}%</Text>
          <BoardBatteryIcon size={12} color={boardBatteryColor} />
        </View>
      ),
    });
  }

  if (snapshot?.remoteBatteryPct != null) {
    badges.push({
      key: 'remote-battery',
      glowColor: remoteBatteryColor,
      content: (
        <View style={[styles.batteryBadge, { backgroundColor: surface, borderColor: tint + '55' }]}>
          <MaterialCommunityIcons name="remote-tv" size={13} color={tint} />
          <Text style={[styles.batteryBadgeText, { color: remoteBatteryColor }]}>{snapshot.remoteBatteryPct}%</Text>
          <RemoteBatteryIcon size={12} color={remoteBatteryColor} />
        </View>
      ),
    });
  }

  if (showTuyaStatus && headlightStatus != null) {
    badges.push({
      key: 'headlight',
      glowColor: tint,
      content: (
        <View style={[styles.statusIconBadge, { backgroundColor: surface, borderColor: tint + '55' }]}>
          <HeadlightIcon mode={headlightStatus} color={tint} size={13} />
        </View>
      ),
    });
  }

  if (snapshot?.mode) {
    const ModeIcon = MODE_ICONS[snapshot.mode as keyof typeof MODE_ICONS] ?? Bike;
    badges.push({
      key: 'mode',
      glowColor: modeStatusColor,
      content: (
        <View style={[styles.statusIconBadge, { backgroundColor: surface, borderColor: modeStatusColor + '55' }]}>
          <ModeIcon size={13} color={modeStatusColor} />
        </View>
      ),
    });
  }

  if (rangeKm != null) {
    badges.push({
      key: 'range',
      glowColor: tint,
      content: (
        <View style={[styles.batteryBadge, { backgroundColor: surface, borderColor: tint + '55' }]}>
          <Route size={12} color={tint} />
          <Text style={[styles.batteryBadgeText, { color: tint }]}>{rangeKm} km</Text>
        </View>
      ),
    });
  }

  if (cruiseOn) {
    badges.push({
      key: 'cruise',
      glowColor: tint,
      content: (
        <View style={[styles.statusIconBadge, { backgroundColor: surface, borderColor: tint + '55' }]}>
          <Gauge size={13} color={tint} />
        </View>
      ),
    });
  }

  if (snapshot?.lockOn != null) {
    const LockIcon = snapshot.lockOn ? Lock : LockOpen;
    badges.push({
      key: 'lock',
      glowColor: lockStatusColor,
      content: (
        <View style={[styles.statusIconBadge, { backgroundColor: surface, borderColor: lockStatusColor + '55' }]}>
          <LockIcon size={13} color={lockStatusColor} />
        </View>
      ),
    });
  }

  return (
    <View style={styles.nameRow}>
      <DeviceNameText style={[styles.subtitle, { color: tint }]}>{snapshot?.deviceName ?? `Your ${noun.lower}`}</DeviceNameText>
      <View style={styles.badgeRow}>
        {badges.map((badge, index) => (
          <EntranceBadge key={badge.key} index={index} glowColor={badge.glowColor}>
            {badge.content}
          </EntranceBadge>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  subtitle: { fontSize: 12, lineHeight: 15 },
  badgeRow: { flexDirection: 'row', gap: 6 },
  batteryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  batteryBadgeText: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
  statusIconBadge: { alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderWidth: 1, borderRadius: 999 },
  glowRing: { borderRadius: 999, borderWidth: 2 },
});
