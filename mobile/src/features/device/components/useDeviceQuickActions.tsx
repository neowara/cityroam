import { Footprints, Gauge, Lightbulb, LightbulbOff, Lock, LockOpen } from 'lucide-react-native';

import { HeadlightButtonIcon } from '@/features/device/components/HeadlightIcon';
import { useActiveDeviceBrand, useBleConnectionStatus } from '@/features/device/deviceLink';
import { useActiveDeviceProfile, type QuickActionKey } from '@/features/device/deviceProfile';
import { useHeadlightControl, useLockControl, useRideModeControl } from '@/features/device/boardQuickControls';
import { useNaveeToggle, useNaveeWalkAssist } from '@/features/device/navee/quickControls';
import { MODE_ICONS, MODE_META } from '@/lib/mode';

export type QuickAction = {
  key: QuickActionKey;
  label: string;
  renderIcon: (color: string, size: number) => React.ReactNode;
  /** Mode actions carry their mode's own color; everything else uses the theme tint. */
  accentColor: string | null;
  disabled: boolean;
  /** False for a control whose icon must never look dimmed (the headlight). */
  dimOnDisabled: boolean;
  onPress: () => void;
  /** The underlying hook's own write error (e.g. NO_RESPONSE, REJECTED) — every hook
   * already tracks this via useDeviceWrite, but nothing used to render it, so a failed
   * quick-action press looked identical to a successful one that just didn't change
   * the device: the icon reverted to its pre-press state with no error shown anywhere. */
  error: string | null;
};

/**
 * The quick controls for whichever device is connected, in the order its profile lists
 * them (src/features/device/deviceProfile.ts). Every control hook runs on every render
 * regardless of brand — hook order can't depend on which device is paired — and only the
 * profile's own actions, with data to show, come back. Empty while not connected, so no
 * surface ever offers a control the device can't answer.
 */
export function useDeviceQuickActions(): QuickAction[] {
  const profile = useActiveDeviceProfile();
  const brand = useActiveDeviceBrand();
  const { online } = useBleConnectionStatus();
  const lock = useLockControl();
  const headlight = useHeadlightControl();
  const rideMode = useRideModeControl();
  const cruise = useNaveeToggle('cruise');
  const taillight = useNaveeToggle('taillight');
  const walkAssist = useNaveeWalkAssist();

  // Until the brand is known the profile is only the default, not this device's.
  if (online !== true || brand == null) return [];

  const build = (key: QuickActionKey): QuickAction | null => {
    switch (key) {
      case 'lock':
        if (lock.locked == null) return null;
        return {
          key,
          label: lock.locked ? 'Unlock' : 'Lock',
          renderIcon: (color, size) => (lock.locked ? <Lock color={color} size={size} /> : <LockOpen color={color} size={size} />),
          accentColor: null,
          disabled: lock.sending,
          dimOnDisabled: true,
          onPress: () => void lock.toggle(),
          error: lock.error,
        };
      case 'headlight':
        return {
          key,
          label: headlight.mode === 'static' ? 'Light On' : 'Blinking',
          renderIcon: (color, size) => <HeadlightButtonIcon mode={headlight.mode} color={color} size={size} />,
          accentColor: null,
          disabled: headlight.sending,
          dimOnDisabled: false,
          onPress: () => void headlight.toggle(),
          error: headlight.error,
        };
      case 'rideMode': {
        const mode = rideMode.mode;
        if (mode == null) return null;
        const modes = profile.rideModes;
        const next = modes[(Math.max(0, modes.indexOf(mode)) + 1) % modes.length];
        const ModeIcon = MODE_ICONS[mode];
        return {
          key,
          label: profile.rideModeLabel(mode),
          renderIcon: (_color, size) => <ModeIcon color={MODE_META[mode].color} size={size} />,
          accentColor: MODE_META[mode].color,
          disabled: rideMode.sending,
          dimOnDisabled: true,
          onPress: () => void rideMode.select(next),
          error: rideMode.error,
        };
      }
      case 'cruise':
        if (cruise.on == null) return null;
        return {
          key,
          label: cruise.on ? 'Cruise On' : 'Cruise Off',
          renderIcon: (color, size) => <Gauge color={color} size={size} />,
          accentColor: null,
          disabled: cruise.sending,
          dimOnDisabled: true,
          onPress: () => void cruise.toggle(),
          error: cruise.error,
        };
      case 'walkAssist':
        if (walkAssist.on == null) return null;
        return {
          key,
          label: walkAssist.on ? 'Walking' : 'Walk Assist',
          renderIcon: (color, size) => <Footprints color={color} size={size} />,
          accentColor: null,
          disabled: walkAssist.sending,
          dimOnDisabled: true,
          onPress: () => void walkAssist.toggle(),
          error: walkAssist.error,
        };
      case 'taillight':
        if (taillight.on == null) return null;
        return {
          key,
          label: taillight.on ? 'Tail Light On' : 'Tail Light Off',
          renderIcon: (color, size) =>
            taillight.on ? <Lightbulb color={color} size={size} /> : <LightbulbOff color={color} size={size} />,
          accentColor: null,
          disabled: taillight.sending,
          dimOnDisabled: true,
          onPress: () => void taillight.toggle(),
          error: taillight.error,
        };
    }
  };

  return profile.quickActions.map(build).filter((a): a is QuickAction => a != null);
}
