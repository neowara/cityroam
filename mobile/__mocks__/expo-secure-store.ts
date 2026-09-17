// Manual mock for expo-secure-store (Jest can't load the real native module) — an
// in-memory Map stands in for the Android Keystore-backed store. Root-level
// __mocks__/<pkg>.ts for a node_modules package is auto-applied by Jest without
// needing jest.mock() at each call site.
const store = new Map<string, string>();

export async function getItemAsync(key: string): Promise<string | null> {
  return store.has(key) ? store.get(key)! : null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

// Test-only helper to reset state between test cases (same reasoning as
// AsyncStorage.clear() in beforeEach elsewhere in this repo's tests).
export function __clear(): void {
  store.clear();
}
