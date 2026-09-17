import { Tabs } from 'expo-router';
import { Gauge, ListOrdered, Activity as ActivityIcon, Route as RouteIcon, Settings as SettingsIcon } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';

import FloatingTripButton from '@/features/rides/components/FloatingTripButton';
import { FloatingTabBar } from '@/components/ui/FloatingTabBar';
import { StatusBarScrim } from '@/components/ui/StatusBarScrim';
import { GLASS_GRADIENT, useAppTheme } from '@/lib/theme';
import { useColorScheme } from '@/components/useColorScheme';
import { StyleSheet, View } from 'react-native';

// 5-tab bar (Dashboard/Rides/Activity/Plan/Settings). Trip detail is a pushed
// stack screen (app/trip/[id].tsx), not a tab.
export default function TabLayout() {
  const { accentColor: tint, containerStyle } = useAppTheme();
  const colorScheme = useColorScheme() ?? 'light';
  const isGlass = containerStyle === 'glass';
  const gradientColors = GLASS_GRADIENT[colorScheme];

  return (
    <View style={StyleSheet.absoluteFill}>
      {isGlass && <LinearGradient colors={gradientColors} style={StyleSheet.absoluteFill} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} />}
      <Tabs
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          tabBarActiveTintColor: tint,
          // Native header replaced by each screen's own icon+title row (matches
          // Dashboard's existing pattern) — one title per screen instead of a plain
          // native bar plus a redundant custom heading underneath it.
          headerShown: false,
          // Let the gradient above show through every screen's transparent content
          // (each tab's own `container` style is already `{flex:1}` with no bg) instead
          // of the navigation theme painting an opaque background over it.
          sceneStyle: isGlass ? { backgroundColor: 'transparent' } : undefined,
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ color }) => <Gauge color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="rides"
          options={{
            title: 'Rides',
            tabBarIcon: ({ color }) => <ListOrdered color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="activity"
          options={{
            title: 'Activity',
            tabBarIcon: ({ color }) => <ActivityIcon color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="planner"
          options={{
            title: 'Plan',
            tabBarIcon: ({ color }) => <RouteIcon color={color} size={22} />,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ color }) => <SettingsIcon color={color} size={22} />,
          }}
        />
      </Tabs>
      {/* Visible on Dashboard/Rides/Trip Detail, not Settings or the planner tab; hides itself. */}
      <FloatingTripButton />
      <StatusBarScrim />
    </View>
  );
}
