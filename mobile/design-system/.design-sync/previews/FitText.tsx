import { View, FitText, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const Canonical = () => (
  <View style={{ width: 160 }}>
    <FitText style={{ fontSize: 28, fontWeight: '700', color: light.text }}>12.4</FitText>
  </View>
);

export const NarrowContainer = () => (
  <View style={{ width: 90 }}>
    <FitText style={{ fontSize: 28, fontWeight: '700', color: light.text }}>12.34 km/%</FitText>
  </View>
);

export const LongLabel = () => (
  <View style={{ width: 140 }}>
    <FitText style={{ fontSize: 18, fontWeight: '600', color: light.inkDim }}>Average speed today</FitText>
  </View>
);
