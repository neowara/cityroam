import { View, ChartAxisLabel, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const LeftAligned = () => (
  <View style={{ width: 260, height: 24, position: 'relative' }}>
    <ChartAxisLabel label="06:00" left={0} width={60} color={light.inkDim} align="left" />
  </View>
);

export const CenterAligned = () => (
  <View style={{ width: 260, height: 24, position: 'relative' }}>
    <ChartAxisLabel label="12:00" left={100} width={60} color={light.inkDim} align="center" />
  </View>
);

export const RightAligned = () => (
  <View style={{ width: 260, height: 24, position: 'relative' }}>
    <ChartAxisLabel label="18:00" left={200} width={60} color={light.inkDim} align="right" />
  </View>
);

export const FullAxis = () => (
  <View style={{ width: 260, height: 24, position: 'relative' }}>
    <ChartAxisLabel label="06:00" left={0} width={60} color={light.inkDim} align="left" />
    <ChartAxisLabel label="12:00" left={100} width={60} color={light.inkDim} align="center" />
    <ChartAxisLabel label="18:00" left={200} width={60} color={light.inkDim} align="right" />
  </View>
);
