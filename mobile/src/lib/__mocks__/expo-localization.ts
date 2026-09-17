/** Test double for the parts of expo-localization the app uses — the real package
 * pulls in native modules jest can't load. */
export function getLocales(): { regionCode?: string | null; languageTag: string }[] {
  return [{ regionCode: 'US', languageTag: 'en-US' }];
}

export const getCalendars = () => [];
export const getTimeZone = () => 'UTC';
