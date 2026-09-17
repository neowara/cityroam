import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Appearance settings are purely cosmetic, local-only (never synced to the backend).
// Real embedded typefaces for all 3 body choices: Space Grotesk pairs with the already-bundled Space Mono by design; Manrope for "Modern" instead of the default Inter.
// Headers/emphasis text (fontStyleFor() below) always renders in ClashDisplay_Bold — the
// same face as the "Cityroam" wordmark (components/ui/CityroamMark.tsx) — regardless of
// which body font is picked, rather than that being its own selectable "Display" choice.
// The old "Display" choice rendered headers in Sixtyfour_Bled50_Scan0, a leftover
// pre-rebrand face unrelated to the actual logo; removed rather than fixed in place; a
// persisted 'display' choice from before this change falls back to the default below.

export type FontChoice = 'dash' | 'modern' | 'mono';
export type AccentChoice = 'orange' | 'teal' | 'blue' | 'amber';
export type ContainerStyle = 'matte' | 'glass';
type FontWeight = 'regular' | 'medium' | 'bold';

const STORAGE_KEY = 'turbo.appearance';

export const ACCENT_COLORS: Record<AccentChoice, string> = {
  orange: '#f5793a', // Ember
  teal: '#14b8a6', // Volt
  blue: '#2f95dc', // Cobalt
  amber: '#ffa63d', // Cityroam — the rebrand's city-lights accent
};

export const ACCENT_LABELS: Record<AccentChoice, string> = { orange: 'Ember', teal: 'Volt', blue: 'Cobalt', amber: 'Amber' };
export const FONT_LABELS: Record<FontChoice, string> = { dash: 'Dashboard', modern: 'Modern', mono: 'Mono' };
export const CONTAINER_LABELS: Record<ContainerStyle, string> = { matte: 'Matte', glass: 'Glass' };

// One fixed gradient per theme (not per-accent), shared by every screen that supports Glass mode for consistency.
export const GLASS_GRADIENT: { light: [string, string]; dark: [string, string] } = {
  light: ['#dce9fb', '#f1e9f7'],
  dark: ['#0f1830', '#05070d'],
};

// A custom family is selected by picking the right named weight (expo-font registers each under its own name) — pairing with an RN `fontWeight` style doesn't reliably map for a custom TTF on Android.
// `regular` (components/Themed.tsx's `Text` default, no explicit fontWeight) is now
// genuinely light, not the `medium` row under another name — so body copy and headings
// read as two different weights instead of one weight used almost everywhere.
// `fontFamilyFor()` reads from this table; the headers-only ClashDisplay_Bold face below
// is never reachable through it, only through `fontStyleFor()`.
const FONT_FAMILIES: Record<FontChoice, Record<FontWeight, string>> = {
  dash: { regular: 'SpaceGrotesk_300Light', medium: 'SpaceGrotesk_500Medium', bold: 'SpaceGrotesk_700Bold' },
  modern: { regular: 'Manrope_300Light', medium: 'Manrope_600SemiBold', bold: 'Manrope_700Bold' },
  mono: { regular: 'SpaceMono', medium: 'SpaceMono', bold: 'SpaceMono' }, // only one weight exists
};

// The "Cityroam" wordmark's face (components/ui/CityroamMark.tsx) — only one weight
// exists, and it's only ever used via `fontStyleFor()`, never `fontFamilyFor()`/FONT_FAMILIES.
const DISPLAY_FONT_FAMILY = 'ClashDisplay_Bold';

// mono tightened -0.2 -> -0.4 — SpaceMono's wider fixed-width glyphs were overflowing/wrapping text sized for the other proportional fonts.
const LETTER_SPACING: Record<FontChoice, number> = { dash: 0.3, modern: 0, mono: -0.4 };

/** Body-text path — used by components/Themed.tsx's default `Text`. */
export function fontFamilyFor(font: FontChoice, weight: FontWeight = 'regular'): string {
  return FONT_FAMILIES[font][weight];
}

export function letterSpacingFor(font: FontChoice): number {
  return LETTER_SPACING[font];
}

/** For headings/emphasis spots — screen titles, big stat values — that want a heavier
 * face than the app-wide body default (see components/Themed.tsx). Always the
 * "Cityroam" wordmark's ClashDisplay_Bold, independent of the selected body font
 * (`font`/`weight` only decide the header's letter-spacing here, matching how the body
 * text around it is tracked). Never combine with a `fontWeight` style — the font file
 * itself is the weight. */
export function fontStyleFor(font: FontChoice, weight: FontWeight = 'bold'): { fontFamily: string; letterSpacing: number } {
  void weight; // kept for call-site symmetry with fontFamilyFor; the family is fixed regardless
  return { fontFamily: DISPLAY_FONT_FAMILY, letterSpacing: LETTER_SPACING[font] };
}

type Appearance = { font: FontChoice; accent: AccentChoice; containerStyle: ContainerStyle };

// amber is the rebrand's own accent — the default now that the app ships as Cityroam.
// Existing users who explicitly picked an accent keep theirs (persisted appearance).
const DEFAULT_APPEARANCE: Appearance = { font: 'dash', accent: 'amber', containerStyle: 'matte' };

// Lets non-React consumers (e.g. the home-screen widget's last-ride cache) stay in lockstep
// with the appearance the moment it changes, without reaching into the React context.
const appearanceListeners = new Set<(appearance: Appearance) => void>();
export function subscribeToAppearance(listener: (appearance: Appearance) => void): () => void {
  appearanceListeners.add(listener);
  return () => appearanceListeners.delete(listener);
}

type ThemeContextValue = Appearance & {
  accentColor: string;
  setFont: (f: FontChoice) => void;
  setAccent: (a: AccentChoice) => void;
  setContainerStyle: (c: ContainerStyle) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  ...DEFAULT_APPEARANCE,
  accentColor: ACCENT_COLORS[DEFAULT_APPEARANCE.accent],
  setFont: () => {},
  setAccent: () => {},
  setContainerStyle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(DEFAULT_APPEARANCE);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
        // 'display' was a real FontChoice before headers switched to always using
        // ClashDisplay_Bold regardless of the body font — anyone who had it picked
        // falls back to the default rather than resolving to a font that no longer exists.
        if (!(parsed.font in FONT_FAMILIES)) parsed.font = DEFAULT_APPEARANCE.font;
        setAppearance(parsed);
      } catch {
        // corrupt/old value — fall back to defaults rather than crash
      }
    });
  }, []);

  const persist = (next: Appearance) => {
    setAppearance(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    appearanceListeners.forEach((listener) => listener(next));
  };

  const value: ThemeContextValue = {
    ...appearance,
    accentColor: ACCENT_COLORS[appearance.accent],
    setFont: (font) => persist({ ...appearance, font }),
    setAccent: (accent) => persist({ ...appearance, accent }),
    setContainerStyle: (containerStyle) => persist({ ...appearance, containerStyle }),
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  return useContext(ThemeContext);
}
