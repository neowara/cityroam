import AsyncStorage from '@react-native-async-storage/async-storage';

// mobile-side login for the backend's new per-user session auth (replaces
// the old shared static API_TOKEN). These tests cover the parts that are pure logic
// (session state transitions, bootstrap-from-stored-token, 401-clears-session),
// mirroring the reasoning in multi-device-pairing.test.ts / pendingSettings.test.ts.
//
// Multibrand + weight persistence: the
// signed-in session now also carries the account's product-family allow-list and the
// persisted last-known rider weight (both from GET /auth/me), and updateSessionFromMe
// refreshes that state after a PUT /auth/me/families or PUT /auth/me/weight.

const mockLogin = jest.fn();
const mockLogout = jest.fn();
const mockMe = jest.fn();
const mockPutWeight = jest.fn();
const mockPutFamilies = jest.fn();

jest.mock('@/lib/api/auth', () => ({
  authApi: {
    login: (...args: unknown[]) => mockLogin(...args),
    logout: (...args: unknown[]) => mockLogout(...args),
    me: (...args: unknown[]) => mockMe(...args),
    putWeight: (...args: unknown[]) => mockPutWeight(...args),
    putFamilies: (...args: unknown[]) => mockPutFamilies(...args),
  },
}));

import * as secureStore from 'expo-secure-store';
import { ensureSessionBootstrapped, getSessionState, resetSessionState, signIn, signOut, updateSessionFromMe } from '@/features/auth/auth';
import { getSessionToken } from '@/lib/api/client';

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(() => resolve()));
};

/** A signed-in session state with the multibrand/weight fields surfaced. */
const signedIn = (email: string, productFamilies: string[] = ['tynee'], riderWeightKg: number | null = null) => ({
  status: 'signedIn' as const,
  email,
  productFamilies,
  riderWeightKg,
});

/** A GET /auth/me response. */
const me = (email: string, overrides: Partial<{ productFamilies: string[]; riderWeightKg: number | null }> = {}) => ({
  userId: 1,
  email,
  riderWeightKg: overrides.riderWeightKg ?? null,
  riderWeightUpdatedAt: overrides.riderWeightKg == null ? null : '2026-09-01T00:00:00Z',
  productFamilies: overrides.productFamilies ?? ['tynee'],
});

describe('session state', () => {
  beforeEach(async () => {
    resetSessionState();
    await AsyncStorage.clear();
    (secureStore as unknown as { __clear: () => void }).__clear();
    mockLogin.mockReset();
    mockLogout.mockReset().mockResolvedValue(undefined);
    mockMe.mockReset();
    mockPutWeight.mockReset();
    mockPutFamilies.mockReset();
  });

  it('signIn persists the token and reports signedIn with the returned email', async () => {
    mockLogin.mockResolvedValue({ token: 'tok-123', userId: 1, email: 'rider@example.com' });
    mockMe.mockResolvedValue(me('rider@example.com'));

    await signIn('rider@example.com', 'hunter2');

    expect(getSessionState()).toEqual(signedIn('rider@example.com'));
    expect(await getSessionToken()).toBe('tok-123');
    expect(mockLogin).toHaveBeenCalledWith('rider@example.com', 'hunter2');
  });

  it('signIn surfaces the account product families and persisted rider weight from /auth/me', async () => {
    mockLogin.mockResolvedValue({ token: 'tok-123', userId: 1, email: 'rider@example.com' });
    mockMe.mockResolvedValue(me('rider@example.com', { productFamilies: ['tynee', 'navee'], riderWeightKg: 82 }));

    await signIn('rider@example.com', 'hunter2');

    expect(getSessionState()).toEqual(signedIn('rider@example.com', ['tynee', 'navee'], 82));
  });

  it('signIn failure (wrong credentials) leaves no token stored and rejects', async () => {
    mockLogin.mockRejectedValue(new Error('401 Unauthorized: {"detail":"Incorrect email or password"}'));

    await expect(signIn('rider@example.com', 'wrong')).rejects.toThrow('401');
    expect(await getSessionToken()).toBeNull();
  });

  it('signOut clears local state even when the best-effort server logout fails', async () => {
    mockLogin.mockResolvedValue({ token: 'tok-123', userId: 1, email: 'rider@example.com' });
    mockMe.mockResolvedValue(me('rider@example.com'));
    await signIn('rider@example.com', 'hunter2');

    mockLogout.mockRejectedValue(new Error('network down'));
    await signOut();

    expect(getSessionState()).toEqual({ status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null });
    expect(await getSessionToken()).toBeNull();
  });

  it('bootstrap reports signedOut immediately when no token is stored', async () => {
    await ensureSessionBootstrapped();
    expect(getSessionState()).toEqual({ status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null });
    expect(mockMe).not.toHaveBeenCalled();
  });

  it('bootstrap validates a stored token against /auth/me and reports signedIn on success', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockResolvedValue(me('existing@example.com', { productFamilies: ['tynee'], riderWeightKg: 90 }));

    await ensureSessionBootstrapped();

    expect(getSessionState()).toEqual(signedIn('existing@example.com', ['tynee'], 90));
  });

  it('a 401 from /auth/me during bootstrap reports signedOut, not a crash, and clears the dead token', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'stale-token');
    mockMe.mockRejectedValue(new Error('401 Unauthorized: {"detail":"invalid or expired token"}'));

    await expect(ensureSessionBootstrapped()).resolves.toBeUndefined();

    expect(getSessionState()).toEqual({ status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null });
    expect(await getSessionToken()).toBeNull();
  });

  it('bootstrap with a cached account reports signedIn without waiting on /auth/me', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockResolvedValue(me('existing@example.com', { productFamilies: ['navee'], riderWeightKg: 70 }));
    await ensureSessionBootstrapped();
    resetSessionState();

    mockMe.mockReset().mockReturnValue(new Promise(() => {}));
    await ensureSessionBootstrapped();

    expect(getSessionState()).toEqual(signedIn('existing@example.com', ['navee'], 70));
  });

  it('a network error during bootstrap keeps the session and the token', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockResolvedValue(me('existing@example.com', { productFamilies: ['navee'] }));
    await ensureSessionBootstrapped();
    resetSessionState();

    mockMe.mockReset().mockRejectedValue(new Error('Network request failed'));
    await ensureSessionBootstrapped();
    await flushPromises();

    expect(getSessionState()).toEqual(signedIn('existing@example.com', ['navee']));
    expect(await getSessionToken()).toBe('tok-456');
  });

  it('a network error on a first launch with no cached account still opens signed in', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockRejectedValue(new Error('Request to /api/v1/auth/me timed out after 20s'));

    await ensureSessionBootstrapped();

    expect(getSessionState()).toEqual({ status: 'signedIn', email: null, productFamilies: ['tynee'], riderWeightKg: null });
    expect(await getSessionToken()).toBe('tok-456');
  });

  it('a 401 from the background check signs out a session restored from cache', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockResolvedValue(me('existing@example.com'));
    await ensureSessionBootstrapped();
    resetSessionState();

    mockMe.mockReset().mockRejectedValue(new Error('401 Unauthorized: {"detail":"invalid or expired token"}'));
    await ensureSessionBootstrapped();
    await flushPromises();

    expect(getSessionState()).toEqual({ status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null });
    expect(await getSessionToken()).toBeNull();
  });

  it('signOut forgets the cached account', async () => {
    mockLogin.mockResolvedValue({ token: 'tok-123', userId: 1, email: 'rider@example.com' });
    mockMe.mockResolvedValue(me('rider@example.com'));
    await signIn('rider@example.com', 'hunter2');
    await signOut();
    await flushPromises();

    expect(await AsyncStorage.getItem('turbo.cachedAccount')).toBeNull();
  });

  it('bootstrap only ever runs once — a second call reuses the first in-flight/settled promise', async () => {
    await secureStore.setItemAsync('turbo.sessionToken', 'tok-456');
    mockMe.mockResolvedValue(me('existing@example.com'));

    await Promise.all([ensureSessionBootstrapped(), ensureSessionBootstrapped()]);

    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  it('updateSessionFromMe refreshes the signed-in session after a weight/families PUT', async () => {
    mockLogin.mockResolvedValue({ token: 'tok-123', userId: 1, email: 'rider@example.com' });
    mockMe.mockResolvedValue(me('rider@example.com'));
    await signIn('rider@example.com', 'hunter2');

    // Simulate the response of PUT /auth/me/weight — the caller passes the returned MeResponse.
    updateSessionFromMe(me('rider@example.com', { riderWeightKg: 78 }));

    expect(getSessionState()).toEqual(signedIn('rider@example.com', ['tynee'], 78));
  });

  it('updateSessionFromMe is a no-op when not signed in', async () => {
    await ensureSessionBootstrapped(); // no token -> signedOut

    updateSessionFromMe(me('rider@example.com', { productFamilies: ['navee'] }));

    expect(getSessionState()).toEqual({ status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null });
  });
});
