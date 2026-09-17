import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { authApi, getSessionToken, setSessionToken, clearSessionToken, onSessionExpired, type MeResponse } from '@/lib/api';
import { DEFAULT_BRAND } from '@/lib/api/devices';
import { createListenable } from '@/lib/listenable';

// real per-user session state, replacing the old "always signed in via a
// baked-in static token" world. Module-level so every useSession() call site shares
// one source of truth, same shape as deviceLink's paired-device epoch: a Set of
// listeners notified on change, plus a hook that subscribes/unsubscribes on mount.
//
// Multibrand + weight persistence: the
// signed-in state also carries the account's product-family allow-list (which catalog
// and pairing UI to show) and the persisted last-known rider weight (the estimate
// fallback when Health Connect is unavailable). Both come from GET /auth/me.

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut';

type SessionState = {
  status: SessionStatus;
  email: string | null;
  productFamilies: string[];
  riderWeightKg: number | null;
};

// Signed-out/loading has no account, so no families and no persisted weight.
const SIGNED_OUT_STATE: SessionState = { status: 'signedOut', email: null, productFamilies: [], riderWeightKg: null };

let state: SessionState = { status: 'loading', email: null, productFamilies: [], riderWeightKg: null };
const stateChanged = createListenable();

function setState(next: SessionState): void {
  state = next;
  stateChanged.notify();
}

/** Build the signed-in session state from a GET /auth/me response. */
function signedInState(me: MeResponse): SessionState {
  return {
    status: 'signedIn',
    email: me.email,
    productFamilies: me.productFamilies ?? [],
    riderWeightKg: me.riderWeightKg ?? null,
  };
}

// The last /auth/me response, so a cold start can show the app without waiting on the
// network. Not a credential: the token itself stays in SecureStore.
const CACHED_ACCOUNT_KEY = 'turbo.cachedAccount';
// How long a first launch with no cached account waits on /auth/me before showing the app anyway.
const FIRST_BOOTSTRAP_WAIT_MS = 5_000;

type CachedAccount = Pick<MeResponse, 'email' | 'productFamilies' | 'riderWeightKg'>;

async function readCachedAccount(): Promise<CachedAccount | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHED_ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as CachedAccount) : null;
  } catch {
    return null;
  }
}

function cacheAccount(me: MeResponse): void {
  const account: CachedAccount = { email: me.email, productFamilies: me.productFamilies, riderWeightKg: me.riderWeightKg };
  AsyncStorage.setItem(CACHED_ACCOUNT_KEY, JSON.stringify(account)).catch(() => {});
}

function clearCachedAccount(): void {
  AsyncStorage.removeItem(CACHED_ACCOUNT_KEY).catch(() => {});
}

function applyMe(me: MeResponse): void {
  cacheAccount(me);
  setState(signedInState(me));
}

// client.ts formats HTTP failures as "<status> <statusText>: <body>".
function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('401 ');
}

function signOutLocally(): void {
  clearCachedAccount();
  setState(SIGNED_OUT_STATE);
}

/** Checks the stored token against /auth/me. Only a 401 ends the session: being offline,
 * a timeout or a server restart must never sign the rider out. */
async function validateStoredSession(): Promise<void> {
  try {
    applyMe(await authApi.me());
  } catch (err) {
    if (isUnauthorized(err)) {
      await clearSessionToken();
      signOutLocally();
    }
  }
}

// Runs once per app lifetime. With a stored token the app opens signed in straight away
// (from the cached account when there is one) and validates in the background.
let bootstrapPromise: Promise<void> | null = null;
function bootstrap(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = getSessionToken()
    .then(async (token) => {
      if (!token) {
        signOutLocally();
        return;
      }
      const cached = await readCachedAccount();
      if (cached) {
        setState(signedInState({ userId: 0, riderWeightUpdatedAt: null, ...cached }));
        void validateStoredSession();
        return;
      }
      // No cached account yet (first launch on this build). Wait briefly for the real one,
      // then fall back to the server's default families rather than holding the splash.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        validateStoredSession(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FIRST_BOOTSTRAP_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      if (state.status === 'loading') {
        setState({ status: 'signedIn', email: null, productFamilies: [DEFAULT_BRAND], riderWeightKg: null });
      }
    })
    .catch(() => signOutLocally());
  return bootstrapPromise;
}

/** Re-checks the session, e.g. on foreground return, so an account change or a revoked
 * token shows up without a restart. No-op unless signed in. */
export function revalidateSession(): Promise<void> {
  if (state.status !== 'signedIn') return Promise.resolve();
  return validateStoredSession();
}

// A 401 from any in-flight request (client.ts) means the session died mid-app-use —
// react immediately rather than waiting for the next manual auth check.
onSessionExpired(() => {
  if (state.status === 'signedIn') signOutLocally();
});

// Plain functions, not only reachable through the hook, so lib logic tests (see
// lib/__tests__/auth.test.ts) can exercise sign-in/sign-out/bootstrap without
// rendering a React component — same split as deviceLink's activateBleDevice
// (plain function) vs. usePairedDeviceEpoch (the hook wrapper around it).
export async function signIn(email: string, password: string): Promise<void> {
  const res = await authApi.login(email, password);
  await setSessionToken(res.token);
  // LoginResponse only carries token/userId/email — fetch /auth/me for the full
  // account state (productFamilies, persisted rider weight) so the session reflects
  // the account's enabled families immediately after sign-in.
  applyMe(await authApi.me());
}

export async function signOut(): Promise<void> {
  // Best-effort — don't let a network failure/already-expired token stop the local
  // sign-out, which must always succeed from the user's point of view.
  await authApi.logout().catch(() => {});
  await clearSessionToken();
  signOutLocally();
}

/** Runs (once) the stored-token-vs-/auth/me bootstrap check and resolves once it
 * settles — exported so tests can await bootstrap completion deterministically
 * instead of polling `getSessionState()`. useSession() below calls this too but
 * ignores the returned promise (fire-and-forget on mount, same as before). */
export function ensureSessionBootstrapped(): Promise<void> {
  return bootstrap();
}

export function getSessionState(): SessionState {
  return state;
}

/** Replace the current session with the account state from a fresh GET /auth/me (or
 * the response of PUT /auth/me/families / PUT /auth/me/weight). Used after a families
 * or weight update so the module-level session reflects the persisted change without
 * a full sign-out/sign-in round-trip. No-op unless currently signed in. */
export function updateSessionFromMe(me: MeResponse): void {
  if (state.status !== 'signedIn') return;
  applyMe(me);
}

export function useSession(): SessionState & { signIn: typeof signIn; signOut: typeof signOut } {
  bootstrap();
  const [, forceRender] = useState(0);
  useEffect(() => stateChanged.subscribe(() => forceRender((n) => n + 1)), []);
  return { ...state, signIn, signOut };
}

// Test-only — module state (bootstrap-once flag + current session) otherwise persists
// across test cases within the same file, same reasoning as tuyaBleSession's resetBleSession.
export function resetSessionState(): void {
  bootstrapPromise = null;
  state = { status: 'loading', email: null, productFamilies: [], riderWeightKg: null };
}
