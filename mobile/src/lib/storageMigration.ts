import AsyncStorage from '@react-native-async-storage/async-storage';

// Shared by deviceLink's legacy-single-device migration and deviceLink/session.ts's
// legacy-flat-cache-key migrations — both were independently implementing the same
// "check-already-migrated -> run migrate() -> done" template (code review finding,
// ) before this was extracted.

const inFlight = new Map<string, Promise<void>>();

/** Runs `migrate` at most once per `newKey` ever — if `newKey` already holds a
 * value, this is a no-op (already migrated, or a fresh install with real
 * new-format data already present). Concurrent calls for the same `newKey` share
 * one in-flight promise (dedupes a real race — e.g. two components both reading
 * paired state on mount), but the promise is never cached past settling, so a
 * later genuine change to AsyncStorage (or a test clearing storage between cases)
 * is never masked by a stale resolved promise. */
export function migrateOnce(newKey: string, migrate: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(newKey);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const already = await AsyncStorage.getItem(newKey);
      if (already != null) return;
      await migrate();
    } finally {
      inFlight.delete(newKey);
    }
  })();
  inFlight.set(newKey, promise);
  return promise;
}
