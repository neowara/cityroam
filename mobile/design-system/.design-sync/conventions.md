## Wrapping and setup

Every screen must be wrapped in two providers, in this order (outer to inner):

```tsx
<SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, right: 0, bottom: 34, left: 0 } }}>
  <ThemeProvider>{/* your screen */}</ThemeProvider>
</SafeAreaProvider>
```

Several components (`ScreenHeader`, `ModuleTitle`, `FloatingBackHeader`, `StatusBarScrim`, `GlassBackdrop`, `FloatingTabBar`) call `useSafeAreaInsets()` internally and throw without a `SafeAreaProvider` ancestor. `ThemeProvider` holds the user's appearance choices (accent color, font family, container style) — components read `accentColor`, `font`, and `containerStyle` from it via `useAppTheme()`, not from props, so don't try to theme a component by passing color props it doesn't have.

**"Glass" vs "Matte" container style.** `ThemeProvider`'s `containerStyle` (`'matte' | 'glass'`) changes how `Card`, `GlassFill`, and `GlassBackdrop` render — matte is a plain solid surface, glass is a translucent tinted panel with a gradient sheen. It defaults to `'matte'`. Change it via `useAppTheme().setContainerStyle('glass')`; there's no prop to set it on mount.

## Styling idiom: React Native StyleSheet objects, not CSS classes

This is a React Native component library rendered through `react-native-web` — there is **no CSS class vocabulary** (no Tailwind, no BEM, no utility classes). Every component takes a `style` prop that's a plain JS object (or array of objects) with camelCase CSS-like properties: `{ paddingVertical: 16, borderRadius: 14, backgroundColor: '#fff' }`. Compose styles by passing arrays: `style={[baseStyle, conditionalStyle]}`. Colors are plain hex/rgba strings, never CSS variables.

**Color tokens** come from the `Colors` export, not hardcoded hex (except the accent, which is theme-controlled):
```ts
Colors.light.{ text, background, surface, surface2, line, inkDim, inkFaint, good, warn, crit, tint }
Colors.dark.{ same keys }
```
The **accent color** (currently `#ffa63d`, amber) is NOT in `Colors` — it comes from `useAppTheme().accentColor`, since it's a user-selectable preference, not a fixed brand token.

**Fonts** are also user-selectable (`font: 'dash' | 'modern' | 'mono'`, default `'dash'` = Space Grotesk). Body text should use `fontFamilyFor(font, weight)` (`weight: 'regular' | 'medium' | 'bold'`) rather than hardcoding a family name, so it follows the user's choice. Headings/emphasis (screen titles, big stat values) use `fontStyleFor(font)` instead — this always renders in `ClashDisplay_Bold` (the brand's display face) regardless of the body font choice. Never combine `fontStyleFor`'s output with an explicit `fontWeight` style — the font file itself is the weight.

## Where the truth lives

- `styles.css` — imports the shipped `fonts.css` (`@font-face` rules for all 8 font files); this is the full CSS surface, since components are styled via inline style objects, not stylesheet rules.
- Each component's own `.d.ts` — the real prop contract (extracted from the shipped types, includes every inherited React Native prop like `accessibilityLabel`, `hitSlop`, etc. — most of those are rarely relevant, focus on the component-specific props at the top).
- Each component's own `.prompt.md` — usage notes and composed examples.

## Example: a themed stat card

```tsx
import { ThemeProvider, SafeAreaProvider, Card, StatTile, useAppTheme } from 'cityroam-design-system';

function RideSummary() {
  const { accentColor } = useAppTheme();
  return (
    <Card style={{ gap: 8 }}>
      <StatTile label="Distance" value="12.4" sub="km" />
      <StatTile label="Duration" value="34" sub="min" />
    </Card>
  );
}
```

Dialogs go through `AppModal` (a styled wrapper over React Native's `Modal` — backdrop, card, close button, optional header/footer, `'card'` or `'fullScreen'` variant), with `ConfirmModalBody` or `ChecklistModalBody` as common bodies for confirmation/multi-select flows.
