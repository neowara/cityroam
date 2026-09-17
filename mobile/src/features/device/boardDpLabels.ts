// Board config dp mapping (dp101-120), cross-referenced against the
// Tuya Smart Life app and the device's own product schema. `confirmed` means an
// exact value/type/order match or a value watched move live against the remote.
//
// The Mode domain (identity/order/labels/colors/icons/decode) lives in
// src/lib/mode.ts, and the DP value decode/format helpers in this folder's
// boardValue.ts. Both are re-exported here so existing importers keep working unchanged.

import { Mode, MODE_ORDER, MODE_META } from '@/lib/mode';

export type { Mode, ModeMeta } from '@/lib/mode';
export { MODE_ORDER, MODE_META, decodeMode, modeLabel, modeColor, MODE_ICONS } from '@/lib/mode';
export { humanizeEnumValue, scaledValue, formatDpValue } from '@/features/device/boardValue';

export type Range = { min: number; max: number; step?: number };

export type ModeDpConfig = {
  speedLimitDp: string;
  accelerationDp: string;
  decelerationDp: string;
  speedLimitConfirmed: boolean;
  accelDecelConfirmed: boolean;
  speedLimitRange: Range;
};

// Fallback shown before the live schema loads — board-config.tsx's SliderRow prefers the schema's real range/step when available.
export const MODE_DP_CONFIG: Record<Mode, ModeDpConfig> = {
  eco: {
    speedLimitDp: '108',
    accelerationDp: '112',
    decelerationDp: '116',
    speedLimitConfirmed: true,
    accelDecelConfirmed: true,
    speedLimitRange: { min: 15, max: 25 },
  },
  ride: {
    speedLimitDp: '109',
    accelerationDp: '113',
    decelerationDp: '117',
    speedLimitConfirmed: true,
    accelDecelConfirmed: true,
    speedLimitRange: { min: 25, max: 35 },
  },
  speed: {
    speedLimitDp: '110',
    accelerationDp: '114',
    decelerationDp: '118',
    speedLimitConfirmed: true,
    accelDecelConfirmed: true,
    speedLimitRange: { min: 35, max: 45 },
  },
  turbo: {
    speedLimitDp: '111',
    accelerationDp: '115',
    decelerationDp: '119',
    speedLimitConfirmed: true,
    accelDecelConfirmed: true,
    speedLimitRange: { min: 45, max: 62 },
  },
};

// Confirmed live: acceleration/deceleration curves are 10-100 in steps of 10, same range for every mode.
export const ACCEL_DECEL_RANGE: Range = { min: 10, max: 100, step: 10 };

// Global (non-per-mode) settings.
export const GLOBAL_DP = {
  autobrake: '107',
  brakePowerMax: '120',
  direction: '101',
  motorType: '103',
  unit: '11',
  voltage: '20',
  battery: '3',
  remotePower: '102',
  wheelDiameter: '104',
  motorRatio: '105',
  motorPolePairs: '106',
  rideMode: '14',
  // dp1/dp8 identities match Tuya's own app (lock, headlight), both plain bool
  // switches. dp1's write round-trips and the board echoes the new
  // value back durably, but whether it actually immobilizes the board (vs. some other
  // BLE-level lock the name suggests) is unconfirmed — "blelock_switch" is Tuya's own
  // dp code, not ours. dp13's identity ('cruise_switch') is confirmed but its actual
  // effect isn't — a write round-trips then the board reverts it to off within
  // milliseconds on its own, and Tuya's own app button didn't visibly react either;
  // treat a cruise write as best-effort, likely gated on the board actually being ridden.
  lock: '1',
  headlight: '8',
  cruise: '13',
} as const;

// Confirmed live: 30-100 in steps of 5.
export const BRAKE_POWER_MAX_RANGE: Range = { min: 30, max: 100, step: 5 };
export const BRAKE_POWER_MAX_CONFIRMED = true;

export type WritableDpMeta = { label: string; unit: string; confirmed: boolean; range?: Range };

// Flat lookup across every writable field, so board-config.tsx can track pending
// edits across all mode tabs at once. `range` only applies to slider-driven mode
// fields — board-info fields get their constraints live from the device's schema.
export const ALL_WRITABLE_DPS: Record<string, WritableDpMeta> = (() => {
  const map: Record<string, WritableDpMeta> = {};
  for (const mode of MODE_ORDER) {
    const cfg = MODE_DP_CONFIG[mode];
    // Label from the single MODE_META source (replacing the old local title-case
    // heuristic) so the two label-derivation paths can't drift apart.
    const label = MODE_META[mode].label;
    map[cfg.speedLimitDp] = {
      label: `${label} speed limit`,
      unit: ' km/h',
      confirmed: cfg.speedLimitConfirmed,
      range: cfg.speedLimitRange,
    };
    map[cfg.accelerationDp] = { label: `${label} acceleration`, unit: '%', confirmed: cfg.accelDecelConfirmed, range: ACCEL_DECEL_RANGE };
    map[cfg.decelerationDp] = { label: `${label} deceleration`, unit: '%', confirmed: cfg.accelDecelConfirmed, range: ACCEL_DECEL_RANGE };
  }
  map[GLOBAL_DP.brakePowerMax] = {
    label: 'Brake power max',
    unit: '%',
    confirmed: BRAKE_POWER_MAX_CONFIRMED,
    range: BRAKE_POWER_MAX_RANGE,
  };
  // These 6 dpId identities are confirmed against Tuya's own app; only accel/decel dp112-119 stay unconfirmed.
  map[GLOBAL_DP.direction] = { label: 'Direction', unit: '', confirmed: true };
  map[GLOBAL_DP.motorType] = { label: 'Motor type', unit: '', confirmed: true };
  map[GLOBAL_DP.unit] = { label: 'Distance unit', unit: '', confirmed: true };
  map[GLOBAL_DP.wheelDiameter] = { label: 'Wheel diameter', unit: 'mm', confirmed: true };
  map[GLOBAL_DP.motorRatio] = { label: 'Motor ratio', unit: '', confirmed: true };
  map[GLOBAL_DP.motorPolePairs] = { label: 'Motor pole pairs', unit: '', confirmed: true };
  return map;
})();
