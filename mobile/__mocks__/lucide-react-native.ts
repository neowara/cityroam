// Manual mock for lucide-react-native: Jest can't transform the package's ESM .mjs
// build (it isn't whitelisted in jest-expo's transformIgnorePatterns), which trips
// the whole module chain once src/lib/mode.ts imports icons (deviceLink -> boardDpLabels
// -> mode pull it in). Root-level __mocks__/<pkg>.ts for a node_modules package is
// auto-applied by Jest without needing jest.mock() at each call site (same pattern
// as expo-secure-store.ts / expo-audio.ts).
//
// Icons are no-op components — tests only need the named exports to exist, and nothing
// renders them in the test environment. Kept to the icon names reachable from
// src/lib/mode.ts's MODE_ICONS; component-only consumers aren't unit-tested.
const NoopIcon = () => null;

export const Leaf = NoopIcon;
export const Bike = NoopIcon;
export const Gauge = NoopIcon;
export const Rocket = NoopIcon;
