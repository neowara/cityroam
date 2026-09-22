import { View, CityroamMark } from 'cityroam-design-system';

export const Default = () => (
  <View style={{ padding: 16 }}>
    <CityroamMark size={48} routeColor="#1A1D22" />
  </View>
);

export const Small = () => (
  <View style={{ padding: 16 }}>
    <CityroamMark size={24} routeColor="#1A1D22" />
  </View>
);

export const CustomColors = () => (
  <View style={{ padding: 16, backgroundColor: '#0D1015' }}>
    <CityroamMark size={48} routeColor="#E8EAED" dotColor="#2E9E4F" xColor="#D93B3B" />
  </View>
);
