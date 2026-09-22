import { View, InfoRow, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const Canonical = () => (
  <View style={{ width: 280 }}>
    <InfoRow label="Distance" value="12.4 km" text={light.text} last />
  </View>
);

export const WithNote = () => (
  <View style={{ width: 280 }}>
    <InfoRow label="Direction" value="Forward" text={light.text} note="Reversing requires the device to be stationary." last />
  </View>
);

export const Stacked = () => (
  <View style={{ width: 280 }}>
    <InfoRow label="Distance" value="12.4 km" text={light.text} />
    <InfoRow label="Duration" value="34 min" text={light.text} />
    <InfoRow label="Top speed" value="27 km/h" text={light.text} last />
  </View>
);
