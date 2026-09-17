import { MODE_ORDER, MODE_META, decodeMode, modeLabel, modeColor } from '@/lib/mode';

describe('decodeMode', () => {
  it('maps raw Tuya level codes to canonical modes', () => {
    expect(decodeMode('level_1')).toBe('eco');
    expect(decodeMode('level_2')).toBe('ride');
    expect(decodeMode('level_3')).toBe('speed');
    expect(decodeMode('level_4')).toBe('turbo');
  });

  it('passes canonical and unknown values through unchanged', () => {
    // Mirrors the backend's idempotent LEVEL_TO_MODE.get(x, x): already-canonical or
    // unknown raw values are returned as-is so the decode is safe to run at the
    // BLE boundary without re-translating stored trips.
    expect(decodeMode('eco')).toBe('eco');
    expect(decodeMode('turbo')).toBe('turbo');
    expect(decodeMode('some_future_mode')).toBe('some_future_mode');
  });
});

describe('modeLabel', () => {
  it('returns the canonical display label for known modes', () => {
    expect(modeLabel('eco')).toBe('Eco');
    expect(modeLabel('ride')).toBe('Ride');
    expect(modeLabel('speed')).toBe('Speed');
    expect(modeLabel('turbo')).toBe('Turbo');
  });

  it('falls back to the raw string for unknown modes', () => {
    expect(modeLabel('warp')).toBe('warp');
  });
});

describe('modeColor', () => {
  it('returns the per-mode color for a known dominant mode', () => {
    expect(modeColor('eco', false)).toBe('#22a55a');
    expect(modeColor('ride', false)).toBe('#2f95dc');
    expect(modeColor('speed', false)).toBe('#f5793a');
    expect(modeColor('turbo', false)).toBe('#e5484d');
  });

  it('returns the neutral mixed color for mixed trips', () => {
    expect(modeColor('eco', true)).toBe('#8B93A1');
  });

  it('returns the neutral color when there is no dominant mode', () => {
    expect(modeColor(null, false)).toBe('#8B93A1');
  });

  it('returns the neutral color for an unknown dominant mode', () => {
    expect(modeColor('warp', false)).toBe('#8B93A1');
  });
});

describe('MODE_ORDER / MODE_META', () => {
  it('lists every mode in display order', () => {
    expect(MODE_ORDER).toEqual(['eco', 'ride', 'speed', 'turbo']);
  });

  it('has a label and hex color for every mode', () => {
    for (const mode of MODE_ORDER) {
      expect(MODE_META[mode].label).toBeTruthy();
      expect(MODE_META[mode].color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});
