import { View, SelectField } from 'cityroam-design-system';

const BOARD_MODELS = ['Meepo City Rider V2', 'Backfire Zealot S', 'Exway Flex ER', 'Wowgo AT2'];

export const Placeholder = () => (
  <View style={{ width: 260 }}>
    <SelectField value="" options={BOARD_MODELS} onChange={() => {}} placeholder="Select board model…" />
  </View>
);

export const Selected = () => (
  <View style={{ width: 260 }}>
    <SelectField value="Backfire Zealot S" options={BOARD_MODELS} onChange={() => {}} placeholder="Select board model…" />
  </View>
);

export const Disabled = () => (
  <View style={{ width: 260 }}>
    <SelectField value="Meepo City Rider V2" options={BOARD_MODELS} onChange={() => {}} disabled />
  </View>
);
