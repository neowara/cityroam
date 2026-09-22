import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { StatTile, Card, SegmentedControl, ThemeProvider, useAppTheme, Colors } from '../dist/index.mjs';

function Demo() {
  const { accentColor } = useAppTheme();
  const [mode, setMode] = useState('ride');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 24, background: Colors.light.background, width: 480 }}>
      <Card>
        <StatTile label="Distance" value="12.4" sub="km" />
      </Card>
      <SegmentedControl options={['ride', 'walk', 'transit']} value={mode} onChange={setMode} accentColor={accentColor} inkDim={Colors.light.inkDim} text={Colors.light.text} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <Demo />
  </ThemeProvider>,
);
