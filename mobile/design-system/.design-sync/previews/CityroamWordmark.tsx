import { View, CityroamWordmark } from 'cityroam-design-system';

export const Default = () => (
  <View style={{ padding: 24, backgroundColor: '#0D1015' }}>
    <CityroamWordmark size={30} cityColor="#E8EAED" />
  </View>
);

export const Large = () => (
  <View style={{ padding: 24, backgroundColor: '#0D1015' }}>
    <CityroamWordmark size={48} cityColor="#E8EAED" roamColor="#ffa63d" />
  </View>
);

export const LightBackground = () => (
  <View style={{ padding: 24, backgroundColor: '#F3F1EC' }}>
    <CityroamWordmark size={30} cityColor="#1A1D22" />
  </View>
);
