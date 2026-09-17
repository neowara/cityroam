import type { BoardDpSchema } from '@/features/device/boardDpSchema';
import { decodeMode, type Mode } from '@/lib/mode';

/**
 * The NAVEE scooter settings Cityroam knows how to read and change — the descriptor the
 * scooter settings screen renders from. Keys match the native table
 * (modules/navee-ble/.../NaveeSettings.kt), which owns the wire commands.
 *
 * A field is only shown when the scooter actually reported it: the native side only
 * emits a key when the scooter's own settings frame is long enough to contain it, so a
 * model with fewer settings simply shows fewer rows. The PID-specific parts (max speed
 * options) follow the official app's own tables.
 *
 * Verified against a real V40i Pro: lock, automatic headlight, energy recovery and the
 * display unit match what the scooter's own app sends, and the ride modes match what its
 * display shows. The rest still come from the decompiled official app, which serves the
 * whole NAVEE lineup — this model reports none of them, so they never render here.
 */

export type NaveeSettingKey =
  | 'rideMode'
  | 'cruise'
  | 'taillight'
  | 'autoHeadlight'
  | 'energyRecovery'
  | 'tcs'
  | 'turnSound'
  | 'startSpeed'
  | 'speedLimit'
  | 'maxSpeed'
  | 'mileageUnit'
  | 'autoLockTime'
  | 'locked';

export type NaveeOption = { value: number; label: string };

export type NaveeSettingField =
  | { key: NaveeSettingKey; kind: 'toggle'; label: string; description?: string }
  | { key: NaveeSettingKey; kind: 'choice'; label: string; description?: string; options: (productId: string | null) => NaveeOption[] }
  | { key: NaveeSettingKey; kind: 'speedLimit'; label: string; description?: string; min: number; max: number };

export type NaveeSettingSection = { title: string; fields: NaveeSettingField[] };

// The scooter's own three modes, confirmed against its display. Walking is the slow
// push-along assist, drive the fastest; there is no turbo on this model.
export const NAVEE_MODE_DRIVE = 2;
export const NAVEE_MODE_ECO = 3;
export const NAVEE_MODE_WALK = 11;

// Walking isn't offered here — it's a push-along assist, not a riding level, so it gets
// its own switch (NaveeSettingsScreen's Walk assist row, sharing useNaveeWalkAssist's
// logic with the FAB) instead of sitting as a third option in this picker.
const RIDE_MODES: NaveeOption[] = [
  { value: NAVEE_MODE_ECO, label: 'Eco' },
  { value: NAVEE_MODE_DRIVE, label: 'Drive' },
];

/**
 * MaxSpeedActivity's per-product option lists, keyed by product-id prefix. The official
 * app also has a few family checks (`b4.d.*`) that aren't in the published decompile;
 * anything not listed falls back to the app's own default list.
 */
const MAX_SPEED_BY_PID: [string, number[]][] = [
  ['2544', [25, 30, 35, 40, 45, 50, 55, 60]],
  ['2449', [25, 30, 35, 40, 45, 50, 55, 60, 65]],
  ['2547', [25, 32, 40, 50, 60]],
  ['2585', [25, 32, 40, 50, 70]],
  ['2509', [25, 30, 35, 40]],
  ['2611', [25, 32]],
  ['2612', [25, 32]],
  ['2643', [25, 32]],
  ['2416', [25, 32, 40, 50]],
  ['2538', [25, 32, 40, 50]],
];
const MAX_SPEED_DEFAULT = [25, 32, 40];

export function maxSpeedOptions(productId: string | null): NaveeOption[] {
  const list = (productId && MAX_SPEED_BY_PID.find(([prefix]) => productId.startsWith(prefix))?.[1]) || MAX_SPEED_DEFAULT;
  return list.map((kmh) => ({ value: kmh, label: `${kmh} km/h` }));
}

export const NAVEE_SETTING_SECTIONS: NaveeSettingSection[] = [
  {
    title: 'Riding',
    fields: [
      { key: 'rideMode', kind: 'choice', label: 'Ride mode', options: () => RIDE_MODES },
      { key: 'cruise', kind: 'toggle', label: 'Cruise control' },
      {
        key: 'energyRecovery',
        kind: 'choice',
        label: 'Energy recovery',
        description: 'How strongly the motor brakes and recharges when you let off the throttle.',
        // The scooter takes a strength, not a level: its own app sends 30/60/90 for these
        // three labels. Sending 0/1/2 is accepted and reported back, so it looks like it
        // worked while actually setting the regen to near nothing.
        options: () => [
          { value: 30, label: 'Low' },
          { value: 60, label: 'Medium' },
          { value: 90, label: 'High' },
        ],
      },
      { key: 'tcs', kind: 'toggle', label: 'Traction control' },
    ],
  },
  {
    title: 'Speed',
    fields: [
      { key: 'maxSpeed', kind: 'choice', label: 'Maximum speed', options: maxSpeedOptions },
      { key: 'speedLimit', kind: 'speedLimit', label: 'Custom speed limit', min: 6, max: 25 },
      {
        key: 'startSpeed',
        kind: 'choice',
        label: 'Start speed',
        description: 'The speed you need to kick to before the throttle engages.',
        options: () => [0, 3, 4, 5, 6].map((kmh) => ({ value: kmh, label: kmh === 0 ? 'Off' : `${kmh} km/h` })),
      },
    ],
  },
  {
    title: 'Lights and sound',
    fields: [
      { key: 'autoHeadlight', kind: 'toggle', label: 'Automatic headlight' },
      { key: 'taillight', kind: 'toggle', label: 'Tail light' },
      { key: 'turnSound', kind: 'toggle', label: 'Turn signal sound' },
    ],
  },
  {
    title: 'Scooter',
    fields: [
      {
        key: 'mileageUnit',
        kind: 'choice',
        label: 'Display unit',
        options: () => [
          { value: 0, label: 'km' },
          { value: 1, label: 'miles' },
        ],
      },
      // autoLockTime (0x6F [2, n]) is left out: the official app sends an enum 1/2/3 whose
      // meaning its published decompile doesn't show. Add it once the scooter says.
    ],
  },
];

/** Custom speed limit wire value: km/h with the top bit set when on, 0 when off. */
export function decodeSpeedLimit(raw: number): { enabled: boolean; kmh: number } {
  return { enabled: (raw & 0x80) !== 0, kmh: raw & 0x7f };
}

export function encodeSpeedLimit(enabled: boolean, kmh: number): number {
  return enabled ? 0x80 | (kmh & 0x7f) : 0;
}

/** Only the settings this scooter reported get a row. */
export function visibleSections(dps: Record<string, unknown> | null): NaveeSettingSection[] {
  if (!dps) return [];
  return NAVEE_SETTING_SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((field) => typeof dps[field.key] === 'number'),
  })).filter((section) => section.fields.length > 0);
}

/**
 * The session layer's schema for a NAVEE: only what it derives state from. `charging`
 * is what lets deriveCharging (deviceLink/session.ts) report a charging scooter the same
 * way it does a charging board.
 */
export const NAVEE_DP_SCHEMA: Record<string, BoardDpSchema> = {
  'navee.charging': { id: 'navee.charging', code: 'charging', name: 'Charging', type: 'bool' },
};

/**
 * The ride modes a NAVEE has, in the app's own vocabulary. The scooter's eco and drive
 * are the two riding levels; its walking mode has no canonical equivalent and so isn't
 * offered through the brand-neutral control, only on the scooter's own settings screen.
 */
export const NAVEE_RIDE_MODES: readonly Mode[] = ['eco', 'ride'];

const MODE_TO_DRIVING_MODE: Partial<Record<Mode, number>> = { eco: NAVEE_MODE_ECO, ride: NAVEE_MODE_DRIVE };

/**
 * Turns a write addressed in the app's canonical dp vocabulary into the NAVEE setting
 * that means the same thing, so brand-neutral controls (the lock and ride-mode quick
 * controls, the reconnect lock re-apply) drive a scooter without knowing it is one.
 * Anything else is already a NAVEE settings key and passes through.
 */
export function naveeSettingForWrite(dpId: string, value: boolean | number | string): { key: string; value: number } {
  if (dpId === '1') {
    // dp1's polarity is inverted (true = unlocked); the scooter's is plain (1 = locked).
    return { key: 'locked', value: value === true ? 0 : 1 };
  }
  if (dpId === '14') {
    const drivingMode = MODE_TO_DRIVING_MODE[decodeMode(String(value))];
    if (drivingMode == null) throw new Error(`A NAVEE has no ${String(value)} mode.`);
    return { key: 'rideMode', value: drivingMode };
  }
  return { key: dpId, value: typeof value === 'boolean' ? (value ? 1 : 0) : Number(value) };
}
