/** Ambient declarations for modules used via lazy require() that have no bundled types. */

declare module 'expo-localization' {
  export function getLocales(): { regionCode?: string | null; languageTag: string }[];
}

// Bundled assets. Metro hands back a numeric asset id, and without these declarations
// TypeScript cannot resolve an `import` of one — an aliased path and a relative one fail
// alike. Assets loaded through `require()` never reach this, which is why the existing
// font and sound loads work without them.
declare module '*.png' {
  const assetId: number;
  export default assetId;
}

declare module '*.ttf' {
  const assetId: number;
  export default assetId;
}

declare module '*.wav' {
  const assetId: number;
  export default assetId;
}
