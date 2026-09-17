/** Ambient declarations for modules used via lazy require() that have no bundled types. */

declare module 'expo-localization' {
  export function getLocales(): { regionCode?: string | null; languageTag: string }[];
}
