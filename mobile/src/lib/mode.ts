// The Mode domain — identity, ordering, labels, colors, icons, and raw-level decoding.
// One cohesive interface every Mode consumer imports (board-config, RangeEstimateModule,
// ModeChip, ModeBreakdown, LiveTripModule, tuyaBle). Mirrors backend
// app/core/constants.py's LEVEL_TO_MODE / ALL_MODES.

import { Leaf, Bike, Gauge, Rocket } from 'lucide-react-native';

export type Mode = 'eco' | 'ride' | 'speed' | 'turbo';

export const MODE_ORDER: readonly Mode[] = ['eco', 'ride', 'speed', 'turbo'];

export type ModeMeta = { label: string; color: string };

// Record<string, ...> (not Record<Mode, ...>) so display code can look up an
// arbitrary/unknown mode string (e.g. a mode label from an old or foreign trip)
// without a cast — MODE_META[m]?.label ?? m stays the safe fallback path.
export const MODE_META: Record<string, ModeMeta> = {
  eco: { label: 'Eco', color: '#22a55a' },
  ride: { label: 'Ride', color: '#2f95dc' },
  speed: { label: 'Speed', color: '#f5793a' },
  turbo: { label: 'Turbo', color: '#e5484d' },
};

// Single source of truth for per-mode icons (previously duplicated in board-config.tsx
// and RangeEstimateModule.tsx). Keyed by Mode so a Mode value always resolves.
export const MODE_ICONS: Record<Mode, typeof Leaf> = {
  eco: Leaf,
  ride: Bike,
  speed: Gauge,
  turbo: Rocket,
};

// level_1..4 -> eco/ride/speed/turbo — same table as backend app/core/constants.py's
// LEVEL_TO_MODE. Idempotent pass-through, exactly like the backend's LEVEL_TO_MODE.get(x, x):
// an already-canonical mode (or an unknown raw value) is returned unchanged.
const LEVEL_TO_MODE: Partial<Record<string, Mode>> = {
  level_1: 'eco',
  level_2: 'ride',
  level_3: 'speed',
  level_4: 'turbo',
};

/** Decode a raw BLE dp14 value ("level_1".."level_4") to its canonical Mode, passing
 * unknown/canonical values through unchanged (mirrors the backend's idempotent
 * LEVEL_TO_MODE.get(x, x) translation). */
export function decodeMode(raw: string): Mode {
  return LEVEL_TO_MODE[raw] ?? (raw as Mode);
}

const MODE_TO_LEVEL: Record<Mode, string> = { eco: 'level_1', ride: 'level_2', speed: 'level_3', turbo: 'level_4' };

/** The inverse of decodeMode, for writing dp14 back to the board. */
export function encodeMode(mode: Mode): string {
  return MODE_TO_LEVEL[mode];
}

/** Display label for a mode, falling back to the raw string when unknown. */
export function modeLabel(mode: string): string {
  return MODE_META[mode]?.label ?? mode;
}

/** For swatch/badge overlays that need a single representative color, not a full chip. */
export function modeColor(dominantMode: string | null, mixed: boolean): string {
  if (mixed) return '#8B93A1';
  if (!dominantMode) return '#8B93A1';
  return MODE_META[dominantMode]?.color ?? '#8B93A1';
}
