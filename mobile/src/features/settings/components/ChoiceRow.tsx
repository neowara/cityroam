import { View } from 'react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { choiceStyles } from '@/features/settings/styles';

export function ChoiceRow<T extends string>({
  options,
  value,
  onChange,
  accentColor,
  swatches,
}: {
  options: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
  accentColor: string;
  swatches?: Record<T, string>;
}) {
  return (
    <View style={choiceStyles.row}>
      {(Object.keys(options) as T[]).map((key) => {
        const selected = key === value;
        return (
          <PressableScale
            key={key}
            onPress={() => onChange(key)}
            style={[choiceStyles.chip, selected && { borderColor: accentColor, backgroundColor: accentColor + '22' }]}>
            {swatches && <View style={[choiceStyles.swatch, { backgroundColor: swatches[key] }]} />}
            <Text style={[choiceStyles.chipText, selected && { color: accentColor, fontWeight: '700' }]}>{options[key]}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
