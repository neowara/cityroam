import { View, Text, Colors } from 'cityroam-design-system';

export const Basic = () => (
  <View style={{ width: 260, padding: 16, borderRadius: 12, backgroundColor: Colors.light.surface, borderWidth: 1, borderColor: Colors.light.line }}>
    <Text style={{ fontSize: 14 }}>A plain themed box.</Text>
  </View>
);

export const ThemedColors = () => (
  <View style={{ flexDirection: 'row', gap: 10 }}>
    <View lightColor={Colors.light.surface2} style={{ width: 90, height: 60, borderRadius: 10 }} />
    <View lightColor={Colors.light.surface} style={{ width: 90, height: 60, borderRadius: 10, borderWidth: 1, borderColor: Colors.light.line }} />
    <View lightColor={Colors.light.tint} style={{ width: 90, height: 60, borderRadius: 10 }} />
  </View>
);

export const Composition = () => (
  <View style={{ width: 280, padding: 16, borderRadius: 14, backgroundColor: Colors.light.surface, gap: 10 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ fontSize: 14, fontWeight: '700' }}>Board status</Text>
      <Text style={{ fontSize: 12, color: Colors.light.inkDim }}>82%</Text>
    </View>
    <View style={{ height: 8, borderRadius: 4, backgroundColor: Colors.light.surface2 }}>
      <View style={{ width: '82%', height: 8, borderRadius: 4, backgroundColor: Colors.light.good }} />
    </View>
  </View>
);
