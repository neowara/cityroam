import { View, StatusBarScrim } from 'cityroam-design-system';

// Absolute-fill (pinned to top, height driven by the safe-area inset), so it
// needs an explicitly-sized positioned parent to show inside (see NOTES.md).
export const Default = () => (
  <View style={{ position: 'relative', width: 320, height: 160, overflow: 'hidden', borderRadius: 12, backgroundColor: '#3a6ea5' }}>
    <StatusBarScrim />
  </View>
);

export const OverPhotoContent = () => (
  <View style={{ position: 'relative', width: 320, height: 160, overflow: 'hidden', borderRadius: 12, backgroundColor: '#4a8a5c' }}>
    <StatusBarScrim />
  </View>
);
