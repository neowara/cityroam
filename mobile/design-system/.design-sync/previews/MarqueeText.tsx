import { View, MarqueeText, Colors } from 'cityroam-design-system';

const { light } = Colors;

export const ShortText = () => (
  <View style={{ width: 220 }}>
    <MarqueeText style={{ fontSize: 14, color: light.text }}>Ready to ride</MarqueeText>
  </View>
);

export const OverflowingText = () => (
  <View style={{ width: 160 }}>
    <MarqueeText style={{ fontSize: 14, color: light.text }}>
      Bluetooth connection lost, reconnecting to your device
    </MarqueeText>
  </View>
);

export const WarningBanner = () => (
  <View style={{ width: 200 }}>
    <MarqueeText style={{ fontSize: 13, fontWeight: '600', color: light.warn }}>
      Low battery, charge before your next trip
    </MarqueeText>
  </View>
);
