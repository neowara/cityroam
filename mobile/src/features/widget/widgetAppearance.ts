import AsyncStorage from '@react-native-async-storage/async-storage';

import { ACCENT_COLORS, type AccentChoice, type ContainerStyle, type FontChoice } from '@/lib/theme';

/**
 * The home-screen widget's own font/accent — independent of the app's theme
 * (turbo.appearance). The widget previously mirrored theme.tsx live, which meant
 * changing the app's font silently changed what the widget rendered too (and could
 * crash the native renderer — see CityroamWidgetProvider's font handling). Seeded once
 * from the app's current appearance the first time this module loads with no saved
 * widget appearance yet, then fully decoupled from then on: changing one never
 * touches the other.
 *
 * The widget only supports the three fonts it ships precompiled layouts for (see
 * cityroam_widget.xml / cityroam_widget_modern.xml / cityroam_widget_mono.xml) — "display" has
 * no widget layout, so it's mapped to "dash" here, mirroring theme.tsx's own body-text
 * fallback for that choice.
 */

export type WidgetFontChoice = 'dash' | 'modern' | 'mono';
// The gauge needle's own color, independent of the app/widget accent — 'accent' points it
// at the widget's current accent color (the default); 'ink' points it at the theme's text
// color instead, so the needle reads as a separate instrument pointer against the dial.
export type WidgetNeedleChoice = 'accent' | 'ink';
export type WidgetAppearance = { font: WidgetFontChoice; accent: AccentChoice; needle: WidgetNeedleChoice; containerStyle: ContainerStyle };

const WIDGET_APPEARANCE_KEY = 'turbo.widget.appearance';
// Same key theme.tsx persists its own appearance under — read once, at seed time only.
const APP_APPEARANCE_KEY = 'turbo.appearance';

const DEFAULT_WIDGET_APPEARANCE: WidgetAppearance = { font: 'dash', accent: 'orange', needle: 'accent', containerStyle: 'matte' };

function toWidgetFont(font: FontChoice | WidgetFontChoice | undefined): WidgetFontChoice {
  return font === 'modern' || font === 'mono' ? font : 'dash';
}

function toWidgetNeedle(needle: unknown): WidgetNeedleChoice {
  return needle === 'ink' ? 'ink' : 'accent';
}

function toWidgetContainerStyle(containerStyle: unknown): ContainerStyle {
  return containerStyle === 'glass' ? 'glass' : 'matte';
}

let widgetAppearance: WidgetAppearance = DEFAULT_WIDGET_APPEARANCE;

const listeners = new Set<(appearance: WidgetAppearance) => void>();

export function getWidgetFont(): WidgetFontChoice {
  return widgetAppearance.font;
}

export function getWidgetAccent(): AccentChoice {
  return widgetAppearance.accent;
}

export function getWidgetAccentColor(): string {
  return ACCENT_COLORS[widgetAppearance.accent] ?? ACCENT_COLORS[DEFAULT_WIDGET_APPEARANCE.accent];
}

export function getWidgetNeedle(): WidgetNeedleChoice {
  return widgetAppearance.needle;
}

export function getWidgetContainerStyle(): ContainerStyle {
  return widgetAppearance.containerStyle;
}

/** Fires whenever the widget's own appearance changes, so widgetSync can re-push
 * immediately instead of waiting for an unrelated push. */
export function subscribeToWidgetAppearance(listener: (appearance: WidgetAppearance) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persist(next: WidgetAppearance): void {
  widgetAppearance = next;
  AsyncStorage.setItem(WIDGET_APPEARANCE_KEY, JSON.stringify(next)).catch(() => {});
  listeners.forEach((listener) => listener(next));
}

export function setWidgetFont(font: WidgetFontChoice): void {
  persist({ ...widgetAppearance, font });
}

export function setWidgetAccent(accent: AccentChoice): void {
  persist({ ...widgetAppearance, accent });
}

export function setWidgetNeedle(needle: WidgetNeedleChoice): void {
  persist({ ...widgetAppearance, needle });
}

export function setWidgetContainerStyle(containerStyle: ContainerStyle): void {
  persist({ ...widgetAppearance, containerStyle });
}

/** Hydrates the widget's own appearance at startup. If the widget has never had its
 * own saved choice yet (first run after this feature shipped, or a fresh install),
 * seeds it once from the app's current appearance so the widget doesn't jump to an
 * unrelated default look — after that seed, the two are fully independent. Call once
 * before the first snapshot push, same as widgetLastRide's loadWidgetContext. */
export async function loadWidgetAppearance(): Promise<void> {
  const raw = await AsyncStorage.getItem(WIDGET_APPEARANCE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      widgetAppearance = {
        font: toWidgetFont(parsed.font),
        accent: parsed.accent ?? DEFAULT_WIDGET_APPEARANCE.accent,
        // Existing installs persisted before this field existed have no `needle`/
        // `containerStyle` key — their own defaults ('accent'/'matte') cover that the
        // same way toWidgetFont already covers a pre-widget-appearance font value.
        needle: toWidgetNeedle(parsed.needle),
        containerStyle: toWidgetContainerStyle(parsed.containerStyle),
      };
      return;
    } catch {
      // corrupt/old value — fall through to reseed
    }
  }

  let seeded = DEFAULT_WIDGET_APPEARANCE;
  const rawAppAppearance = await AsyncStorage.getItem(APP_APPEARANCE_KEY);
  if (rawAppAppearance) {
    try {
      const parsed = JSON.parse(rawAppAppearance);
      // The app's own appearance (theme.tsx) has no needle concept to seed from — the
      // widget's needle always starts at the default regardless of what's being seeded.
      // containerStyle DOES exist on the app's own appearance, so it seeds from it same
      // as font/accent.
      seeded = {
        font: toWidgetFont(parsed.font),
        accent: parsed.accent ?? DEFAULT_WIDGET_APPEARANCE.accent,
        needle: DEFAULT_WIDGET_APPEARANCE.needle,
        containerStyle: toWidgetContainerStyle(parsed.containerStyle),
      };
    } catch {
      // corrupt/old value — keep defaults
    }
  }
  widgetAppearance = seeded;
  await AsyncStorage.setItem(WIDGET_APPEARANCE_KEY, JSON.stringify(seeded)).catch(() => {});
}
