// Verifies the widget's own appearance is independent of the app's theme: it seeds once
// from the app's current appearance the first time it's loaded with nothing saved yet,
// then never follows the app's theme again, and setters persist + notify listeners.

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  getWidgetAccent,
  getWidgetAccentColor,
  getWidgetContainerStyle,
  getWidgetFont,
  getWidgetNeedle,
  loadWidgetAppearance,
  setWidgetAccent,
  setWidgetContainerStyle,
  setWidgetFont,
  setWidgetNeedle,
  subscribeToWidgetAppearance,
} from '@/features/widget/widgetAppearance';

const WIDGET_APPEARANCE_KEY = 'turbo.widget.appearance';
const APP_APPEARANCE_KEY = 'turbo.appearance';

describe('widgetAppearance', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('defaults to dash/orange/accent with nothing saved anywhere', async () => {
    await loadWidgetAppearance();
    expect(getWidgetFont()).toBe('dash');
    expect(getWidgetAccent()).toBe('orange');
    expect(getWidgetAccentColor()).toBe('#f5793a');
    expect(getWidgetNeedle()).toBe('accent');
    expect(getWidgetContainerStyle()).toBe('matte');
  });

  it('seeds once from the app appearance when the widget has no saved choice yet', async () => {
    await AsyncStorage.setItem(APP_APPEARANCE_KEY, JSON.stringify({ font: 'modern', accent: 'teal', containerStyle: 'glass' }));

    await loadWidgetAppearance();

    expect(getWidgetFont()).toBe('modern');
    expect(getWidgetAccent()).toBe('teal');
    expect(getWidgetContainerStyle()).toBe('glass');
    // The seed is persisted under the widget's own key so it's decoupled from here on.
    expect(JSON.parse((await AsyncStorage.getItem(WIDGET_APPEARANCE_KEY)) ?? '{}')).toEqual({
      font: 'modern',
      accent: 'teal',
      needle: 'accent',
      containerStyle: 'glass',
    });
  });

  it('maps the app appearance\'s "display" font to "dash" when seeding (no widget layout for it)', async () => {
    await AsyncStorage.setItem(APP_APPEARANCE_KEY, JSON.stringify({ font: 'display', accent: 'blue' }));

    await loadWidgetAppearance();

    expect(getWidgetFont()).toBe('dash');
  });

  it('never re-seeds from the app appearance once the widget has its own saved choice', async () => {
    await AsyncStorage.setItem(WIDGET_APPEARANCE_KEY, JSON.stringify({ font: 'mono', accent: 'blue' }));
    await AsyncStorage.setItem(APP_APPEARANCE_KEY, JSON.stringify({ font: 'modern', accent: 'teal' }));

    await loadWidgetAppearance();

    expect(getWidgetFont()).toBe('mono');
    expect(getWidgetAccent()).toBe('blue');
  });

  it('setWidgetFont/setWidgetAccent persist independently and notify listeners', async () => {
    await loadWidgetAppearance();
    const listener = jest.fn();
    const unsubscribe = subscribeToWidgetAppearance(listener);

    setWidgetFont('mono');
    expect(getWidgetFont()).toBe('mono');
    expect(listener).toHaveBeenCalledTimes(1);

    setWidgetAccent('teal');
    expect(getWidgetAccent()).toBe('teal');
    expect(getWidgetAccentColor()).toBe('#14b8a6');
    expect(listener).toHaveBeenCalledTimes(2);

    setWidgetNeedle('ink');
    expect(getWidgetNeedle()).toBe('ink');
    expect(listener).toHaveBeenCalledTimes(3);

    setWidgetContainerStyle('glass');
    expect(getWidgetContainerStyle()).toBe('glass');
    expect(listener).toHaveBeenCalledTimes(4);

    // The app's own appearance key must be untouched by widget-side changes.
    expect(await AsyncStorage.getItem(APP_APPEARANCE_KEY)).toBeNull();

    unsubscribe();
  });

  it('round-trips needle through persistence, defaulting an old saved blob with no needle key to "accent"', async () => {
    // Simulates an install that saved its widget appearance before the needle field
    // existed — toWidgetNeedle's fallback must apply on load, same as toWidgetFont
    // already does for a pre-existing font value.
    await AsyncStorage.setItem('turbo.widget.appearance', JSON.stringify({ font: 'mono', accent: 'blue' }));
    await loadWidgetAppearance();
    expect(getWidgetNeedle()).toBe('accent');

    setWidgetNeedle('ink');
    await loadWidgetAppearance(); // re-load should be a no-op once a choice is saved
    expect(getWidgetNeedle()).toBe('ink');
  });

  it('round-trips containerStyle through persistence, defaulting an old saved blob with no containerStyle key to "matte"', async () => {
    await AsyncStorage.setItem('turbo.widget.appearance', JSON.stringify({ font: 'mono', accent: 'blue' }));
    await loadWidgetAppearance();
    expect(getWidgetContainerStyle()).toBe('matte');

    setWidgetContainerStyle('glass');
    await loadWidgetAppearance(); // re-load should be a no-op once a choice is saved
    expect(getWidgetContainerStyle()).toBe('glass');
  });
});
