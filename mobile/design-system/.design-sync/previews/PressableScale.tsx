import { View, Text, PressableScale, Colors } from 'cityroam-design-system';

export const Pill = () => (
  <PressableScale
    onPress={() => {}}
    style={{
      alignSelf: 'flex-start',
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 999,
      backgroundColor: Colors.light.tint,
    }}>
    <Text style={{ color: '#1a1200', fontWeight: '700' }}>Start trip</Text>
  </PressableScale>
);

export const OutlineButton = () => (
  <PressableScale
    onPress={() => {}}
    style={{
      alignSelf: 'flex-start',
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: Colors.light.line,
    }}>
    <Text style={{ color: Colors.light.text, fontWeight: '600' }}>Cancel</Text>
  </PressableScale>
);

export const Disabled = () => (
  <PressableScale
    disabled
    onPress={() => {}}
    style={{
      alignSelf: 'flex-start',
      paddingVertical: 10,
      paddingHorizontal: 18,
      borderRadius: 999,
      backgroundColor: Colors.light.tint,
      opacity: 0.4,
    }}>
    <Text style={{ color: '#1a1200', fontWeight: '700' }}>Restore trip</Text>
  </PressableScale>
);
