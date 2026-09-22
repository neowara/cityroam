import { useState } from 'react';
import { View, SegmentedControl, Colors } from 'cityroam-design-system';

const { light } = Colors;

function Demo({ options, initial }: { options: string[]; initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <View style={{ width: 280 }}>
      <SegmentedControl options={options} value={value} onChange={setValue} accentColor="#ffa63d" inkDim={light.inkDim} text={light.text} />
    </View>
  );
}

// initial is always the FIRST option — SegmentedControl's highlight pill
// animates in from index 0 on every mount (see NOTES.md), so a demo whose
// value starts elsewhere gets captured mid-spring, reading as "wrong
// selection". Starting at index 0 shows the real, settled styling.
export const TwoOptions = () => <Demo options={['ride', 'walk']} initial="ride" />;

export const ThreeOptions = () => <Demo options={['ride', 'walk', 'transit']} initial="ride" />;

export const LongLabels = () => <Demo options={['Beginner', 'Intermediate', 'Expert']} initial="Beginner" />;
