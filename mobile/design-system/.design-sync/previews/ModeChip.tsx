import { View, ModeChip } from 'cityroam-design-system';

export const Eco = () => (
  <View style={{ padding: 8 }}>
    <ModeChip dominantMode="eco" mixed={false} />
  </View>
);

export const Turbo = () => (
  <View style={{ padding: 8 }}>
    <ModeChip dominantMode="turbo" mixed={false} />
  </View>
);

export const Mixed = () => (
  <View style={{ padding: 8 }}>
    <ModeChip dominantMode="ride" mixed />
  </View>
);

export const RowOfChips = () => (
  <View style={{ flexDirection: 'row', gap: 14, padding: 8 }}>
    <ModeChip dominantMode="eco" mixed={false} />
    <ModeChip dominantMode="speed" mixed={false} />
    <ModeChip dominantMode="ride" mixed />
  </View>
);
