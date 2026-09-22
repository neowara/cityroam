import { View, Text, Colors } from 'cityroam-design-system';

export const Sizes = () => (
  <View style={{ padding: 16, gap: 8 }}>
    <Text style={{ fontSize: 28, fontWeight: '700' }}>Ride summary</Text>
    <Text style={{ fontSize: 17, fontWeight: '600' }}>Distance covered</Text>
    <Text style={{ fontSize: 14 }}>12.4 km over 34 minutes at an average of 18.2 km/h.</Text>
    <Text style={{ fontSize: 12 }}>Last synced 2 minutes ago</Text>
  </View>
);

export const Weights = () => (
  <View style={{ padding: 16, gap: 6 }}>
    <Text style={{ fontSize: 16, fontWeight: '400' }}>Regular: Board status</Text>
    <Text style={{ fontSize: 16, fontWeight: '500' }}>Medium: Board status</Text>
    <Text style={{ fontSize: 16, fontWeight: '700' }}>Bold: Board status</Text>
  </View>
);

export const ThemedColors = () => (
  <View style={{ flexDirection: 'row', gap: 12, padding: 16 }}>
    <View style={{ padding: 12, borderRadius: 10, backgroundColor: Colors.light.surface }}>
      <Text lightColor={Colors.light.good} style={{ fontSize: 14, fontWeight: '600' }}>
        Battery healthy
      </Text>
    </View>
    <View style={{ padding: 12, borderRadius: 10, backgroundColor: Colors.light.surface }}>
      <Text lightColor={Colors.light.crit} style={{ fontSize: 14, fontWeight: '600' }}>
        Connection lost
      </Text>
    </View>
  </View>
);
