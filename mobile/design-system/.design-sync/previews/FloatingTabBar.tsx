import { View, FloatingTabBar } from 'cityroam-design-system';
import { MapPinIcon, SettingsIcon } from './_icons';

const ROUTES = [
  { key: 'dashboard', name: 'Dashboard', icon: MapPinIcon, title: 'Dashboard' },
  { key: 'settings', name: 'Settings', icon: SettingsIcon, title: 'Settings' },
];

function mockNav(focusedIndex: number) {
  const state = { index: focusedIndex, routes: ROUTES.map((r) => ({ key: r.key, name: r.name })) };
  const descriptors = Object.fromEntries(
    ROUTES.map((r) => [
      r.key,
      { options: { title: r.title, tabBarIcon: ({ color, size }: { color: string; size: number }) => <r.icon size={size} color={color} /> } },
    ]),
  );
  const navigation = { emit: () => ({ defaultPrevented: false }), navigate: () => {} };
  return { state, descriptors, navigation, insets: { top: 0, bottom: 0, left: 0, right: 0 } };
}

export const DashboardFocused = () => {
  const nav = mockNav(0);
  return (
    <View style={{ position: 'relative', width: 360, height: 120, backgroundColor: '#F3F1EC' }}>
      <FloatingTabBar {...nav} />
    </View>
  );
};

export const SettingsFocused = () => {
  const nav = mockNav(1);
  return (
    <View style={{ position: 'relative', width: 360, height: 120, backgroundColor: '#F3F1EC' }}>
      <FloatingTabBar {...nav} />
    </View>
  );
};
