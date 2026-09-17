import { useActiveDeviceBrand } from '@/features/device/deviceLink';
import { DEFAULT_BRAND } from '@/lib/api';
import { MODE_META, MODE_ORDER, type Mode } from '@/lib/mode';
import { isNaveeDevId } from '@/features/device/navee/credentials';
import { NAVEE_RIDE_MODES } from '@/features/device/navee/settings';

/**
 * What differs per device brand, in one place, so shared UI (dashboard pills, the FAB,
 * trip details, range and planner modules) reads the profile instead of branching on a
 * brand string itself. Adding a brand means adding a profile here plus its native
 * module — not touching every component. Protocol-level differences live below this, in
 * the native modules and lib/deviceLink/transport.ts.
 */

export type QuickActionKey = 'lock' | 'rideMode' | 'headlight' | 'cruise' | 'taillight' | 'walkAssist';

export type StatusExtraKey = 'rangeKm' | 'cruise';

export type DeviceProfile = {
  brand: string;
  /** The ride modes this device has, slowest first, in the app's mode vocabulary. */
  rideModes: readonly Mode[];
  /** FAB/quick-control label for a mode. */
  rideModeLabel: (mode: Mode) => string;
  /** MaterialCommunityIcons glyph for the device itself. */
  deviceIcon: 'skateboard' | 'scooter-electric';
  /** Quick controls the FAB offers while connected, top to bottom. */
  quickActions: readonly QuickActionKey[];
  /** Status pills beyond the brand-neutral battery/mode/lock ones. */
  statusExtras: readonly StatusExtraKey[];
  /** Pack voltages a real reading can fall in; anything outside is a decoding error,
   * not a battery, and is left out of the voltage graph. */
  plausibleVoltageV: { min: number; max: number };
};

const TYNEE: DeviceProfile = {
  brand: DEFAULT_BRAND,
  rideModes: MODE_ORDER,
  // A board's modes are numbered on its remote.
  rideModeLabel: (mode) => `${MODE_ORDER.indexOf(mode) + 1} Mode`,
  deviceIcon: 'skateboard',
  quickActions: ['lock', 'headlight', 'rideMode'],
  statusExtras: [],
  plausibleVoltageV: { min: 20, max: 80 },
};

const NAVEE: DeviceProfile = {
  brand: 'navee',
  // Confirmed on a V40i Pro by cycling the modes on its own display: walking, eco and
  // drive, reported as 11, 3 and 2. The 5 the decompiled app calls "turbo" is not a mode
  // this scooter has. Walking is a push-along assist rather than a riding level, so it is
  // a quick action of its own instead of a step in the mode cycle.
  rideModes: NAVEE_RIDE_MODES,
  // A scooter's modes have names on its display.
  rideModeLabel: (mode) => MODE_META[mode]?.label ?? mode,
  deviceIcon: 'scooter-electric',
  quickActions: ['lock', 'rideMode', 'walkAssist', 'cruise', 'taillight'],
  statusExtras: ['rangeKm', 'cruise'],
  // Covers the whole lineup: 36 V (V40i Pro) up to 57.6 V (UT5 Ultra X) packs. The
  // native voltage scale is UNVERIFIED.
  plausibleVoltageV: { min: 20, max: 80 },
};

const PROFILES: Record<string, DeviceProfile> = { [TYNEE.brand]: TYNEE, [NAVEE.brand]: NAVEE };

export function profileForBrand(brand: string | null | undefined): DeviceProfile {
  return (brand && PROFILES[brand]) || TYNEE;
}

/** For data tied to a specific device (a saved trip). No device id means a trip from
 * before per-device tracking, which only ever came from a Tynee board. */
export function profileForDevId(devId: string | null | undefined): DeviceProfile {
  return isNaveeDevId(devId) ? NAVEE : TYNEE;
}

/** The active device's profile; the default (Tynee) profile while nothing is paired. */
export function useActiveDeviceProfile(): DeviceProfile {
  return profileForBrand(useActiveDeviceBrand());
}

/** A specific device's profile when one is selected (e.g. the dashboard's device
 * filter), otherwise the active device's. */
export function useDeviceProfileFor(devId: string | null | undefined): DeviceProfile {
  const active = useActiveDeviceProfile();
  return devId ? profileForDevId(devId) : active;
}
