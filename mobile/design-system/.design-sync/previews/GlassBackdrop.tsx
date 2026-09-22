import { useEffect } from 'react';
import { View, GlassBackdrop, useAppTheme } from 'cityroam-design-system';

// GlassBackdrop is absolute-fill (gradient + StatusBarScrim), so it needs an
// explicitly-sized positioned parent, and glass mode active for the gradient
// layer to paint at all (see NOTES.md).
function GlassDemo({ children }: { children: React.ReactNode }) {
  const { setContainerStyle } = useAppTheme();
  useEffect(() => {
    setContainerStyle('glass');
  }, []);
  return <>{children}</>;
}

export const Glass = () => (
  <GlassDemo>
    <View style={{ position: 'relative', width: 320, height: 200, overflow: 'hidden', borderRadius: 12 }}>
      <GlassBackdrop />
    </View>
  </GlassDemo>
);

// Matte mode: the gradient layer is glass-only and skips rendering, but the
// StatusBarScrim it always renders internally still paints — this is the
// expected matte look for GlassBackdrop, not a bug.
export const Matte = () => (
  <View style={{ position: 'relative', width: 320, height: 200, overflow: 'hidden', borderRadius: 12, backgroundColor: '#e8e5df' }}>
    <GlassBackdrop />
  </View>
);
