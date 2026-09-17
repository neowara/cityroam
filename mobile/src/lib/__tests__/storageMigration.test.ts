import AsyncStorage from '@react-native-async-storage/async-storage';

import { migrateOnce } from '@/lib/storageMigration';

// Extracted from deviceLink/deviceLink/session.ts's two independently-implemented
// "already migrated?" checks (code review finding) — this is the shared
// primitive both now use.

describe('migrateOnce', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('runs the migration when newKey has no value yet', async () => {
    const migrate = jest.fn().mockResolvedValue(undefined);
    await migrateOnce('new-key', migrate);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('does not re-run once newKey already has a value', async () => {
    await AsyncStorage.setItem('new-key', 'already-migrated');
    const migrate = jest.fn().mockResolvedValue(undefined);
    await migrateOnce('new-key', migrate);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('runs again on a later call if newKey is still unset (migrate() itself left nothing, e.g. no legacy data)', async () => {
    const migrate = jest.fn().mockResolvedValue(undefined); // never actually writes newKey
    await migrateOnce('new-key', migrate);
    await migrateOnce('new-key', migrate);
    expect(migrate).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent calls for the same key into one in-flight migration', async () => {
    const migrate = jest.fn().mockResolvedValue(undefined);
    // Called back-to-back in the same tick, before either's first await resolves —
    // migrateOnce registers the in-flight promise synchronously (before any await),
    // so the second call sees it already registered and reuses it.
    await Promise.all([migrateOnce('new-key', migrate), migrateOnce('new-key', migrate)]);

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('does not dedupe calls for different keys', async () => {
    const migrate = jest.fn().mockResolvedValue(undefined);
    await Promise.all([migrateOnce('key-a', migrate), migrateOnce('key-b', migrate)]);
    expect(migrate).toHaveBeenCalledTimes(2);
  });
});
