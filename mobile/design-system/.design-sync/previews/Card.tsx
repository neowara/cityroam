import { useEffect } from 'react';
import { View, Text, Card, useAppTheme, StatTile } from 'cityroam-design-system';

// Glass mode is internal state on ThemeProvider with no init prop — flip it on
// mount so the glass export actually demonstrates the glass look (see NOTES.md).
function GlassDemo({ children }: { children: React.ReactNode }) {
  const { setContainerStyle } = useAppTheme();
  useEffect(() => {
    setContainerStyle('glass');
  }, []);
  return <>{children}</>;
}

export const Matte = () => (
  <View style={{ width: 300, padding: 16 }}>
    <Card>
      <Text style={{ fontSize: 15, fontWeight: '700' }}>Last ride</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <StatTile label="Distance" value="12.4" sub="km" />
        <StatTile label="Duration" value="34" sub="min" />
      </View>
    </Card>
  </View>
);

export const Glass = () => (
  <GlassDemo>
    <View style={{ width: 300, padding: 16 }}>
      <Card>
        <Text style={{ fontSize: 15, fontWeight: '700' }}>Last ride</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <StatTile label="Distance" value="12.4" sub="km" />
          <StatTile label="Duration" value="34" sub="min" />
        </View>
      </Card>
    </View>
  </GlassDemo>
);

export const StackedGlassCards = () => (
  <GlassDemo>
    <View style={{ width: 300, padding: 16, gap: 10 }}>
      <Card>
        <Text style={{ fontSize: 14, fontWeight: '700' }}>Board status</Text>
        <Text style={{ fontSize: 12 }}>Connected · 82% battery</Text>
      </Card>
      <Card>
        <Text style={{ fontSize: 14, fontWeight: '700' }}>Ride mode</Text>
        <Text style={{ fontSize: 12 }}>Speed</Text>
      </Card>
    </View>
  </GlassDemo>
);
