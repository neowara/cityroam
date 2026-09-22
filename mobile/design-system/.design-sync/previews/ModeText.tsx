import { View, ModeText } from 'cityroam-design-system';

export const AllModes = () => (
  <View style={{ flexDirection: 'row', gap: 12, padding: 8 }}>
    <ModeText mode="eco" style={{ fontSize: 16, fontWeight: '600' }} />
    <ModeText mode="ride" style={{ fontSize: 16, fontWeight: '600' }} />
    <ModeText mode="speed" style={{ fontSize: 16, fontWeight: '600' }} />
    <ModeText mode="turbo" style={{ fontSize: 16, fontWeight: '600' }} />
  </View>
);

export const Lowercase = () => (
  <View style={{ padding: 8 }}>
    <ModeText mode="speed" lowercase style={{ fontSize: 14 }} />
  </View>
);

export const MixedBlend = () => (
  <View style={{ padding: 8 }}>
    <ModeText mode="eco" mixed label="Mixed modes" style={{ fontSize: 16, fontWeight: '600' }} />
  </View>
);
