import { View, WeatherBadge, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const Clear = () => (
  <View style={{ padding: 12 }}>
    <WeatherBadge weatherCodes={[0]} feelsLikeC={19} windSpeedMs={2.3} color={light.inkDim} />
  </View>
);

export const Rainy = () => (
  <View style={{ padding: 12 }}>
    <WeatherBadge weatherCodes={[61]} feelsLikeC={11} windSpeedMs={4.8} color={light.inkDim} />
  </View>
);

export const MixedConditions = () => (
  <View style={{ padding: 12 }}>
    <WeatherBadge weatherCodes={[1, 61, 95]} feelsLikeC={14} windSpeedMs={6.1} color={light.inkDim} />
  </View>
);

export const LargerSize = () => (
  <View style={{ padding: 12 }}>
    <WeatherBadge weatherCodes={[3]} feelsLikeC={9} windSpeedMs={3.4} size={20} color={light.text} />
  </View>
);
