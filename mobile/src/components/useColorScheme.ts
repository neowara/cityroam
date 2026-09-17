import { useColorScheme as useRNColorScheme } from 'react-native';

// RN's ColorSchemeName includes 'unspecified' (Android's "no preference set" theme
// value) and null/undefined — normalized here to just 'light' | 'dark' so every call
// site can safely index Colors[...] without a runtime-undefined lookup.
export function useColorScheme(): 'light' | 'dark' {
  const scheme = useRNColorScheme();
  return scheme === 'dark' ? 'dark' : 'light';
}
