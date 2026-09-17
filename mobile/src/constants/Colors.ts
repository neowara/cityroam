const tintColorLight = '#2f95dc';
const tintColorDark = '#fff';

// Surface/line/ink tokens ported from the prototype (prototype/index.html's :root and
// :root[data-theme="light"] blocks) — this is what "match the prototype exactly" means
// in React Native terms, since there's no CSS custom-property cascade to lean on here.
export default {
  light: {
    text: '#1A1D22',
    background: '#F3F1EC',
    surface: '#FFFFFF',
    surface2: '#FAF8F4',
    line: '#E4E0D8',
    inkDim: '#6B7280',
    inkFaint: '#9CA3AF',
    good: '#2E9E4F',
    warn: '#B8860B',
    crit: '#D93B3B',
    tint: tintColorLight,
    tabIconDefault: '#ccc',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#E8EAED',
    background: '#0D1015',
    surface: '#171B22',
    surface2: '#1D222B',
    line: '#262C37',
    inkDim: '#8B93A1',
    inkFaint: '#565E6C',
    good: '#6FCF6A',
    warn: '#F2C94C',
    crit: '#FF5C5C',
    tint: tintColorDark,
    tabIconDefault: '#ccc',
    tabIconSelected: tintColorDark,
  },
};
