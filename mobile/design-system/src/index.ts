// Re-exports the app's real UI source (mobile/src) through a web-buildable
// pipeline — see mobile/design-system/README (if present) or the design-sync
// plan for why this package exists. Nothing here reimplements a component;
// only the native-only leaf deps (expo-blur, expo-linear-gradient,
// @react-native-community/slider) are swapped for web shims, via tsup.config.ts's
// esbuild alias map, not by editing the imports below.

export { Text, View, useThemeColor } from '../../src/components/Themed';
export { useColorScheme } from '../../src/components/useColorScheme';
export { ThemeProvider, useAppTheme, ACCENT_COLORS, ACCENT_LABELS, FONT_LABELS, CONTAINER_LABELS, GLASS_GRADIENT, fontFamilyFor, fontStyleFor, letterSpacingFor } from '../../src/lib/theme';
export type { FontChoice, AccentChoice, ContainerStyle } from '../../src/lib/theme';
export { default as Colors } from '../../src/constants/Colors';
// Several components (ScreenHeader, FloatingBackHeader, StatusBarScrim,
// GlassBackdrop, FloatingTabBar) call useSafeAreaInsets() internally and
// throw without a SafeAreaProvider ancestor — re-exported so design-sync's
// preview provider chain (.design-sync/config.json) can wrap one. Already
// inlined into dist/ via tsup.config.ts's noExternal, so this is free.
export { SafeAreaProvider } from 'react-native-safe-area-context';

export { AppModal } from '../../src/components/ui/AppModal';
export { Card, GlassFill } from '../../src/components/ui/Card';
export { ChartAxisLabel } from '../../src/components/ui/ChartAxisLabel';
export { ChecklistModalBody } from '../../src/components/ui/ChecklistModalBody';
export { CityroamMark, CityroamWordmark } from '../../src/components/ui/CityroamMark';
export { ConfirmModalBody } from '../../src/components/ui/ConfirmModalBody';
export { EnumFieldRow } from '../../src/components/ui/EnumFieldRow';
export { FitText } from '../../src/components/ui/FitText';
export { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '../../src/components/ui/FloatingBackHeader';
export { FloatingTabBar } from '../../src/components/ui/FloatingTabBar';
export { GlassBackdrop } from '../../src/components/ui/GlassBackdrop';
export { InfoRow } from '../../src/components/ui/InfoRow';
export { MarqueeText } from '../../src/components/ui/MarqueeText';
export { ModeChip } from '../../src/components/ui/ModeChip';
export { ModeSelectModal } from '../../src/components/ui/ModeSelectModal';
export { ModeText } from '../../src/components/ui/ModeText';
export { ModuleTitle } from '../../src/components/ui/ModuleTitle';
export { NumberFieldRow } from '../../src/components/ui/NumberFieldRow';
export { PressableScale } from '../../src/components/ui/PressableScale';
export { RefreshSpinButton } from '../../src/components/ui/RefreshSpinButton';
export { ScreenHeader } from '../../src/components/ui/ScreenHeader';
export { SectionLabel } from '../../src/components/ui/SectionLabel';
export { SegmentedControl } from '../../src/components/ui/SegmentedControl';
export { SelectField } from '../../src/components/ui/SelectField';
export { SliderRow } from '../../src/components/ui/SliderRow';
export { StaggerReveal } from '../../src/components/ui/StaggerReveal';
export { StatTile } from '../../src/components/ui/StatTile';
export { StatusBarScrim } from '../../src/components/ui/StatusBarScrim';
export { StatusDot } from '../../src/components/ui/StatusDot';
export { SyncRequiredOverlay } from '../../src/components/ui/SyncRequiredOverlay';
export { WeatherBadge } from '../../src/components/ui/WeatherBadge';
