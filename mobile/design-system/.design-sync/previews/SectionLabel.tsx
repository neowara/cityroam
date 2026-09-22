import { View, SectionLabel } from 'cityroam-design-system';
import { MapPinIcon } from './_icons';

export const WithIcon = () => (
  <View style={{ width: 220 }}>
    <SectionLabel icon={MapPinIcon}>Route</SectionLabel>
  </View>
);

export const NoIcon = () => (
  <View style={{ width: 220 }}>
    <SectionLabel>Notes</SectionLabel>
  </View>
);

export const LongLabel = () => (
  <View style={{ width: 220 }}>
    <SectionLabel icon={MapPinIcon}>Battery and range</SectionLabel>
  </View>
);
