import { useEffect, useRef } from 'react';

import { useBleRawDps, writeBleDp } from '@/features/device/deviceLink';
import { useDeviceWrite } from '@/features/device/boardQuickControls';
import { NAVEE_MODE_ECO, NAVEE_MODE_WALK, type NaveeSettingKey } from '@/features/device/navee/settings';

export type NaveeToggle = { on: boolean | null; sending: boolean; error: string | null; toggle: () => Promise<void> };

/**
 * A NAVEE on/off setting as a quick control (cruise, tail light). Same contract as the
 * board's quick controls: the rendered value only ever comes from what the scooter
 * reported — the scooter re-sends its settings frame after every write — never from
 * the press itself.
 */
export function useNaveeToggle(key: NaveeSettingKey): NaveeToggle {
  const rawDps = useBleRawDps();
  const { sending, error, run } = useDeviceWrite();
  const raw = rawDps?.[key];
  const on = typeof raw === 'number' ? raw !== 0 : null;
  const toggle = () => run(() => writeBleDp(key, on ? 0 : 1));
  return { on, sending, error, toggle };
}

/**
 * Walking mode as a press-to-hold-then-press-again control: the scooter has no separate
 * "walk assist" command, it is one of the three values of the ride-mode setting, so
 * turning it off has to put back the mode the scooter was riding in rather than a
 * hardcoded default.
 */
export function useNaveeWalkAssist(): NaveeToggle {
  const rawDps = useBleRawDps();
  const { sending, error, run } = useDeviceWrite();
  const raw = rawDps?.rideMode;
  const mode = typeof raw === 'number' ? raw : null;
  const on = mode == null ? null : mode === NAVEE_MODE_WALK;

  // Whatever it was riding in last, to come back to. Eco only stands in for the case
  // where the scooter was already walking when the app connected.
  const previousRidingMode = useRef(NAVEE_MODE_ECO);
  useEffect(() => {
    if (mode != null && mode !== NAVEE_MODE_WALK) previousRidingMode.current = mode;
  }, [mode]);

  const toggle = () => run(() => writeBleDp('rideMode', on ? previousRidingMode.current : NAVEE_MODE_WALK));
  return { on, sending, error, toggle };
}
