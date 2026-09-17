/** One datapoint's definition: its identity, and the constraints the UI renders from. */
export type BoardDpSchema = {
  id: string;
  code: string;
  name: string;
  type: string;
  /** Enum values, in index order — raw BLE sends the index, not the label. */
  range?: string[];
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  unit?: string;
};

/**
 * Compiled-in product schema for the Tynee board — the SDK-free replacement for the
 * SDK's getDeviceSchema() cloud sync. Values match
 * what lib/boardDpLabels.ts hardcodes plus the enum ranges measured against the board
 * (dp11 km/mile, dp14 ride levels, dp101 direction, dp103 motor type).
 *
 * Enum DPs are the trap: raw BLE hands us the integer index, and
 * the `range` arrays below are the index → label mapping the SDK used to resolve for us.
 */

export const BOARD_DP_SCHEMA: Record<string, BoardDpSchema> = {
  // --- telemetry (read-only) ---
  // dp5/6/8/12/13 all feed getBleSnapshot, so they belong here even though none is a
  // user-editable setting — omitting them leaves those readings without a unit or scale.
  '2': { id: '2', code: 'speed', name: 'Speed', type: 'obj', min: 0, max: 600, step: 1, scale: 1, unit: 'km/h' },
  '3': { id: '3', code: 'battery', name: 'Battery', type: 'obj', min: 0, max: 100, step: 1, scale: 0, unit: '%' },
  '5': { id: '5', code: 'mileage_once', name: 'Trip distance', type: 'obj', min: 0, max: 2000, step: 1, scale: 1, unit: 'km' },
  '6': { id: '6', code: 'ridetime_once', name: 'Trip ride time', type: 'obj', min: 0, max: 86400, step: 1, scale: 0, unit: 's' },
  '12': { id: '12', code: 'mileage_total', name: 'Total distance', type: 'obj', min: 0, max: 5000000, step: 1, scale: 1, unit: 'km' },
  '20': { id: '20', code: 'voltage', name: 'Voltage', type: 'obj', min: 0, max: 100000, step: 1, scale: 1, unit: 'V' },

  // --- switches ---
  '1': { id: '1', code: 'blelock_switch', name: 'Board lock', type: 'obj' },
  // A live push decodes to a plain JS boolean (wire type BOOL), not an enum index —
  // disproves an earlier guess that this cycles through off/steady/blink like Tuya's
  // own app button appears to. Plain on/off until real hardware evidence says otherwise.
  '8': { id: '8', code: 'headlight_switch', name: 'Headlight', type: 'obj' },
  '13': { id: '13', code: 'cruise_switch', name: 'Cruise control', type: 'obj' },

  // --- global settings ---
  '11': { id: '11', code: 'unit', name: 'Distance unit', type: 'obj', range: ['km', 'mile'] },
  '14': {
    id: '14',
    code: 'ride_mode',
    name: 'Ride mode',
    type: 'obj',
    range: ['level_1', 'level_2', 'level_3', 'level_4'],
  },
  '101': { id: '101', code: 'direction', name: 'Direction', type: 'obj', range: ['forward', 'back'] },
  '102': { id: '102', code: 'remote_power', name: 'Remote power', type: 'obj' },
  '103': { id: '103', code: 'motor_type', name: 'Motor type', type: 'obj', range: ['hub', 'belt'] },
  '104': { id: '104', code: 'wheel_diameter', name: 'Wheel diameter', type: 'obj', unit: 'mm' },
  '105': { id: '105', code: 'motor_ratio', name: 'Motor ratio', type: 'obj' },
  '106': { id: '106', code: 'motor_pole_pairs', name: 'Motor pole pairs', type: 'obj' },
  '107': { id: '107', code: 'autobrake', name: 'Autobrake', type: 'obj' },
  '120': {
    id: '120',
    code: 'brake_power_max',
    name: 'Brake power max',
    type: 'obj',
    min: 30,
    max: 100,
    step: 5,
    unit: '%',
  },

  // --- per-mode speed limits (eco / ride / speed / turbo) ---
  '108': { id: '108', code: 'eco_speed_limit', name: 'Eco speed limit', type: 'obj', min: 15, max: 25, unit: 'km/h' },
  '109': { id: '109', code: 'ride_speed_limit', name: 'Ride speed limit', type: 'obj', min: 25, max: 35, unit: 'km/h' },
  '110': { id: '110', code: 'speed_speed_limit', name: 'Speed speed limit', type: 'obj', min: 35, max: 45, unit: 'km/h' },
  '111': { id: '111', code: 'turbo_speed_limit', name: 'Turbo speed limit', type: 'obj', min: 45, max: 62, unit: 'km/h' },

  // --- per-mode acceleration (10-100, step 10) ---
  '112': { id: '112', code: 'eco_acceleration', name: 'Eco acceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '113': { id: '113', code: 'ride_acceleration', name: 'Ride acceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '114': { id: '114', code: 'speed_acceleration', name: 'Speed acceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '115': { id: '115', code: 'turbo_acceleration', name: 'Turbo acceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },

  // --- per-mode deceleration (10-100, step 10) ---
  '116': { id: '116', code: 'eco_deceleration', name: 'Eco deceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '117': { id: '117', code: 'ride_deceleration', name: 'Ride deceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '118': { id: '118', code: 'speed_deceleration', name: 'Speed deceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
  '119': { id: '119', code: 'turbo_deceleration', name: 'Turbo deceleration', type: 'obj', min: 10, max: 100, step: 10, unit: '%' },
};

/** The KLV type tag a dpId must be written with on the direct path. Derived from the
 * schema shape the same way board-config's renderer does: enum range → 'enum',
 * min/max bounds → 'value', everything boolean-coded → 'bool'. Strings and raw DPs
 * aren't writable on this product. */
export function dpWriteType(dpId: string, schema: Record<string, BoardDpSchema> | null): 'bool' | 'value' | 'enum' {
  const entry = schema?.[dpId] ?? BOARD_DP_SCHEMA[dpId];
  if (entry?.range) return 'enum';
  // Bounded numerics (speed limits, accel/decel, brake power) and plain numeric DPs
  // are all protocol "value" writes; a bare bool write is only correct for the
  // switch-like DPs, which carry no range and no bounds.
  if (entry && entry.min === undefined && entry.max === undefined) {
    // autobrake / remote power / lock / cruise / headlight: the board itself reports and
    // accepts these as plain on/off switches.
    if (['autobrake', 'remote_power', 'blelock_switch', 'cruise_switch', 'headlight_switch'].includes(entry.code)) return 'bool';
    // Unbounded numerics (battery, voltage, wheel diameter, ratios) are values.
    return 'value';
  }
  return 'value';
}

/**
 * Resolves enum datapoints from the raw index the board sends to the label the rest of
 * the app expects.
 *
 * The SDK used to do this from its cloud-synced schema — dp14 arrived as "level_3", not
 * 2 — and everything downstream (decodeMode, board-config's pickers, the widget) is
 * written against the label. Over raw BLE an enum is just an index into the schema's
 * `range`, so it has to be resolved here or those consumers silently see a number.
 *
 * An index with no matching range entry is left as-is rather than guessed at, so a
 * firmware that grows a new enum value shows something odd rather than the wrong label.
 */
/**
 * The inverse of resolveEnumDps, for the write path.
 *
 * Reads turn an enum's wire index into its schema label, so that is what the pickers
 * hold and hand back — but the wire only accepts the index. Without this the label
 * itself was sent and the native encoder's `toInt()` threw, so every enum setting
 * (direction, motor type, distance unit, ride mode) failed to save.
 *
 * Anything that is not an enum, or is already an index, passes straight through.
 */
export function toWireDpValue(
  dpId: string,
  value: boolean | number | string,
  schema: Record<string, BoardDpSchema> | null,
): boolean | number | string {
  const range = (schema?.[dpId] ?? BOARD_DP_SCHEMA[dpId])?.range;
  if (!range || typeof value !== 'string') return value;
  const index = range.indexOf(value);
  // An unknown label is left alone rather than coerced to 0, which would silently
  // write the wrong setting instead of failing.
  return index >= 0 ? index : value;
}

export function resolveEnumDps(dps: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...dps };
  for (const [dpId, value] of Object.entries(dps)) {
    const range = BOARD_DP_SCHEMA[dpId]?.range;
    if (!range || typeof value !== 'number') continue;
    if (value >= 0 && value < range.length) resolved[dpId] = range[value];
  }
  return resolved;
}

/**
 * Single-datapoint counterpart to resolveEnumDps, for readers that get an enum's raw
 * value on its own rather than as part of a live dp map — the native ride journal
 * stores dp14 as whatever the board sent, stringified ("2"), because it has no access
 * to this schema (it's JS-side only) and is deliberately a raw durability record.
 * Without resolving it on the way back out, `decodeMode` passes the index straight
 * through and the chip renders a bare "2" instead of "Speed" — a real, shipped bug.
 *
 * Accepts the index as a number or as its string form, and leaves anything already
 * resolved (or out of range) untouched, matching resolveEnumDps' own
 * don't-guess-at-unknown-values contract.
 */
export function resolveEnumLabel(dpId: string, value: string | number): string {
  const range = BOARD_DP_SCHEMA[dpId]?.range;
  if (!range) return String(value);
  const index = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= range.length) return String(value);
  return range[index];
}
