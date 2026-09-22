// Web stand-in for @react-native-async-storage/async-storage. The real web
// implementation backs onto window.localStorage, which persists across every
// navigation to the same origin — the design-sync preview harness mounts many
// unrelated cells (often many components) on the same local server origin, so
// real localStorage lets one cell's ThemeProvider persistence (accent/font/
// containerStyle) leak into a totally unrelated cell that never touched it
// (confirmed: a GlassBackdrop "Matte" cell rendered in glass mode because an
// earlier "Glass" cell in the same run had already persisted containerStyle
// to localStorage). This is in-memory only — cleared on every page load, so
// each preview cell's ThemeProvider always starts at its real default.
const store = new Map<string, string>();

const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => store.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
  clear: async (): Promise<void> => {
    store.clear();
  },
};

export default AsyncStorage;
