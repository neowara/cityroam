import { View, Text, FloatingBackHeader } from 'cityroam-design-system';
import { SettingsIcon } from './_icons';

export const Basic = () => (
  <View style={{ width: 360, height: 100 }}>
    <FloatingBackHeader title="Ride details" onPress={() => {}} />
  </View>
);

export const WithIcon = () => (
  <View style={{ width: 360, height: 100 }}>
    <FloatingBackHeader icon={SettingsIcon} title="Board settings" onPress={() => {}} />
  </View>
);

export const WithTrailingAction = () => (
  <View style={{ width: 360, height: 100 }}>
    <FloatingBackHeader
      title="Trip history"
      onPress={() => {}}
      right={
        <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}>
          <SettingsIcon size={18} color="#333" />
        </View>
      }
    />
  </View>
);
