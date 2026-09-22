import { View, ModuleTitle } from 'cityroam-design-system';
import { MapPinIcon, SettingsIcon } from './_icons';

export const LastRide = () => (
  <View style={{ width: 220 }}>
    <ModuleTitle icon={MapPinIcon}>Last ride</ModuleTitle>
  </View>
);

export const RecentRides = () => (
  <View style={{ width: 220 }}>
    <ModuleTitle icon={SettingsIcon}>Recent rides</ModuleTitle>
  </View>
);

export const RangeByMode = () => (
  <View style={{ width: 220 }}>
    <ModuleTitle icon={MapPinIcon}>Range by mode</ModuleTitle>
  </View>
);
