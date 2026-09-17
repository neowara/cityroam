// Single seam for decoding/formatting a Tuya DP value: scale-based numbers
// (raw = display × 10^scale), enum humanizing, and unit attachment. Every value
// formatting/decoding call site imports from here instead of re-deriving the math.

/** Tuya's own enum dp values are raw lowercase codes ("forward", "belt", "km") — this
 * turns one into a human-readable label ("Forward", "Belt", "Km") for display. Not
 * meant to be clever about known values (e.g. expanding "km" to "Kilometers") since
 * the real option set is read live from the device's schema, not hardcoded here. */
export function humanizeEnumValue(value: string): string {
  return value
    .split('_')
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Decode a raw DP integer by its scale (raw = display × 10^scale). scale 0/undefined is a no-op. */
export function decodeScaled(value: number, scale?: number): number {
  return scale ? value / 10 ** scale : value;
}

/** Encode a display value back to the raw DP integer at a given scale. */
export function encodeScaled(display: number, scale?: number): number {
  return scale ? Math.round(display * 10 ** scale) : Math.round(display);
}

/** Format a raw DP integer as a display string at a given scale (1234, scale 2 -> "12.34"). */
export function formatScaled(value: number, scale?: number): string {
  return scale ? (value / 10 ** scale).toFixed(scale) : String(value);
}

export function scaledValue(dpId: string, value: unknown, scale?: number): number | null {
  if (typeof value !== 'number') return null;
  return scale ? value / 10 ** scale : value;
}

export function formatDpValue(dpId: string, value: unknown, opts?: { unit?: string; scale?: number }): string {
  if (typeof value === 'number' && opts?.scale) return `${formatScaled(value, opts.scale)}${opts.unit ?? ''}`;
  if (typeof value === 'number') return `${value}${opts?.unit ?? ''}`;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}
