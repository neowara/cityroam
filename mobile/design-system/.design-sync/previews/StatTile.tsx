import { View, StatTile } from 'cityroam-design-system';

export const Distance = () => (
  <View style={{ width: 160 }}>
    <StatTile label="Distance" value="12.4" sub="km" />
  </View>
);

export const Duration = () => (
  <View style={{ width: 160 }}>
    <StatTile label="Duration" value="34" sub="min" />
  </View>
);

export const NoSubtitle = () => (
  <View style={{ width: 160 }}>
    <StatTile label="Rides" value="128" />
  </View>
);

export const Row = () => (
  <View style={{ flexDirection: 'row', gap: 12 }}>
    <StatTile label="Distance" value="12.4" sub="km" />
    <StatTile label="Avg speed" value="18.2" sub="km/h" />
    <StatTile label="Top speed" value="27" sub="km/h" />
  </View>
);
