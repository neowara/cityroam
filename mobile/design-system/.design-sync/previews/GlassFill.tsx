import { useEffect } from 'react';
import { View, Text, GlassFill, useAppTheme } from 'cityroam-design-system';

// GlassFill is tint + sheen only, no shape of its own — it needs a positioned,
// explicitly-sized parent to render into, and glass mode active since it IS
// the glass tint itself (see NOTES.md).
function GlassDemo({ children }: { children: React.ReactNode }) {
  const { setContainerStyle } = useAppTheme();
  useEffect(() => {
    setContainerStyle('glass');
  }, []);
  return <>{children}</>;
}

export const OnPanel = () => (
  <GlassDemo>
    <View style={{ position: 'relative', width: 280, height: 120, overflow: 'hidden', borderRadius: 14, backgroundColor: '#3a6ea5' }}>
      <GlassFill />
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: 'transparent' }}>
        <Text style={{ fontSize: 14, fontWeight: '700' }}>Last ride</Text>
        <Text style={{ fontSize: 12 }}>12.4 km · 34 min</Text>
      </View>
    </View>
  </GlassDemo>
);

export const OverMapThumbnail = () => (
  <GlassDemo>
    <View style={{ position: 'relative', width: 280, height: 160, overflow: 'hidden', borderRadius: 14, backgroundColor: '#4a8a5c' }}>
      <View style={{ position: 'absolute', top: 0, left: 0, right: 60, bottom: 0, backgroundColor: '#3f7550' }} />
      <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 130 }}>
        <GlassFill />
      </View>
    </View>
  </GlassDemo>
);
