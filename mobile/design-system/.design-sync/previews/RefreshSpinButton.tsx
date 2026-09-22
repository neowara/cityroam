import { View, RefreshSpinButton, Colors } from 'cityroam-design-system';

export const Idle = () => (
  <View style={{ width: 80, height: 60, alignItems: 'center', justifyContent: 'center' }}>
    <RefreshSpinButton onPress={() => {}} spinning={false} color={Colors.light.tint} />
  </View>
);

export const Spinning = () => (
  <View style={{ width: 80, height: 60, alignItems: 'center', justifyContent: 'center' }}>
    <RefreshSpinButton onPress={() => {}} spinning={true} color={Colors.light.tint} />
  </View>
);

export const Disabled = () => (
  <View style={{ width: 80, height: 60, alignItems: 'center', justifyContent: 'center' }}>
    <RefreshSpinButton onPress={() => {}} spinning={false} disabled color={Colors.light.inkFaint} />
  </View>
);

export const LargeSize = () => (
  <View style={{ width: 80, height: 60, alignItems: 'center', justifyContent: 'center' }}>
    <RefreshSpinButton onPress={() => {}} spinning={false} size={24} color={Colors.light.tint} />
  </View>
);
