import { View, StaggerReveal, StatTile } from 'cityroam-design-system';

export const RestingState = () => (
  <View style={{ flexDirection: 'row', gap: 12 }}>
    <StaggerReveal index={0} enabled={false}>
      <StatTile label="Distance" value="12.4" sub="km" />
    </StaggerReveal>
    <StaggerReveal index={1} enabled={false}>
      <StatTile label="Avg speed" value="18.2" sub="km/h" />
    </StaggerReveal>
    <StaggerReveal index={2} enabled={false}>
      <StatTile label="Top speed" value="27" sub="km/h" />
    </StaggerReveal>
  </View>
);

export const SingleTile = () => (
  <View style={{ width: 160 }}>
    <StaggerReveal index={0} enabled={false}>
      <StatTile label="Rides" value="128" />
    </StaggerReveal>
  </View>
);
