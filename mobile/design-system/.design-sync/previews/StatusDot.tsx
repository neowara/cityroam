import { View, StatusDot, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const Connected = () => (
  <View style={{ padding: 12 }}>
    <StatusDot color={light.good} />
  </View>
);

export const Warning = () => (
  <View style={{ padding: 12 }}>
    <StatusDot color={light.warn} />
  </View>
);

export const Critical = () => (
  <View style={{ padding: 12 }}>
    <StatusDot color={light.crit} />
  </View>
);

export const Large = () => (
  <View style={{ padding: 12 }}>
    <StatusDot color={light.good} size={16} />
  </View>
);
