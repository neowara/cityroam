import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { createListenable } from '@/lib/listenable';

const SERVER_ADDRESS_KEY = 'turbo.serverAddress';
const USE_CUSTOM_SERVER_KEY = 'turbo.useCustomServer';
// Real per-person credential now — SecureStore
// (Android Keystore-backed), not AsyncStorage, unlike the old shared static token.
const SESSION_TOKEN_KEY = 'turbo.sessionToken';

// Baked in at build time (EAS secret) so the default user needs no setup; Settings'
// "Custom server" toggle is the escape hatch. EXPO_PUBLIC_* ships in plain text in the
// compiled app — acceptable only because this protects a personal single-user backend behind Cloudflare Access.
const DEFAULT_SERVER_ADDRESS = process.env.EXPO_PUBLIC_DEFAULT_SERVER_ADDRESS ?? '';

export async function getUseCustomServer(): Promise<boolean> {
  return (await AsyncStorage.getItem(USE_CUSTOM_SERVER_KEY)) === 'true';
}

export async function setUseCustomServer(value: boolean): Promise<void> {
  await AsyncStorage.setItem(USE_CUSTOM_SERVER_KEY, value ? 'true' : 'false');
}

export async function getServerAddress(): Promise<string> {
  if (!(await getUseCustomServer())) return DEFAULT_SERVER_ADDRESS;
  return (await AsyncStorage.getItem(SERVER_ADDRESS_KEY)) ?? DEFAULT_SERVER_ADDRESS;
}

export async function setServerAddress(address: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_ADDRESS_KEY, address.replace(/\/+$/, ''));
}

export async function getSessionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(SESSION_TOKEN_KEY);
}

export async function setSessionToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
}

export async function clearSessionToken(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
}

export class ApiNotConfiguredError extends Error {
  constructor() {
    super('No server address set. Add one in Settings.');
    this.name = 'ApiNotConfiguredError';
  }
}

// Cross-module signal for "the session just became invalid" (a 401 from any
// in-flight request) — lets lib/auth.ts's useSession() react immediately without
// every caller having to know about it.
const sessionExpired = createListenable();
export const onSessionExpired = sessionExpired.subscribe;

// The backend serves every business route under /api/v1; only GET /health stays at
// the root, unversioned and unauthenticated. Every backend call funnels through
// `request`, so the prefix is applied in exactly one place — ROOT_PATHS is the
// allow-list of paths that must NOT get the prefix.
const API_V1_PREFIX = '/api/v1';
const ROOT_PATHS: ReadonlySet<string> = new Set(['/health']);

// fetch() has no default timeout on React Native — a flaky/weak connection doesn't
// fail fast, it just hangs, sometimes for minutes, with no error to catch and nothing
// for a caller like saveAndSyncTrip to react to (queue it, retry later). A trip save
// that "hangs" for that long reads to a rider as "it's not working" even though it's
// only slow. Bounded here so a bad connection fails fast and clearly instead.
const REQUEST_TIMEOUT_MS = 20_000;

// Shared fetch wrapper for every backend call. The prefix is applied before any `?`,
// so a path like `/range-estimate?batteryPct=80` becomes
// `/api/v1/range-estimate?batteryPct=80`, while `/health` stays unprefixed.
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return doRequest<T>(path, init, { attachToken: true, handle401: true });
}

/**
 * Same as `request`, for the handful of routes that are public by design (no login
 * required — see `/app/latest-release` and `/app/releases/{version}/download-url`,
 * `lib/api/appRelease.ts`). Two differences from `request`, both deliberate:
 *
 * - Never attaches a Bearer token — there's nothing for a public route to check it
 *   against, and sending a stale/expired one for no reason is one more way a
 *   misconfigured backend could reject it.
 * - Never triggers the 401-clears-session path. A public route is never supposed to
 *   return 401, but if a backend bug or misconfiguration ever made it, `request`'s own
 *   401 handling would sign a rider out over a request they didn't even know required
 *   a session — exactly the failure mode this route exists to survive (an update check
 *   must work through a broken login, not get caught in it).
 */
export async function requestPublic<T>(path: string, init?: RequestInit): Promise<T> {
  return doRequest<T>(path, init, { attachToken: false, handle401: false });
}

async function doRequest<T>(
  path: string,
  init: RequestInit | undefined,
  options: { attachToken: boolean; handle401: boolean },
): Promise<T> {
  const base = await getServerAddress();
  if (!base) throw new ApiNotConfiguredError();

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) };
  if (options.attachToken) {
    const token = await getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const pathWithPrefix = ROOT_PATHS.has(path) ? path : `${API_V1_PREFIX}${path}`;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}${pathWithPrefix}`, { ...init, headers, signal: timeoutController.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request to ${pathWithPrefix} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    // A 401 means the session token is gone (expired/revoked/never valid) — clear it
    // and tell the rest of the app so lib/auth.ts's guard bounces to /login immediately,
    // rather than leaving a dead token around to keep failing silently on every request.
    if (res.status === 401 && options.handle401) {
      await clearSessionToken();
      sessionExpired.notify();
    }
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  // DELETE /trips/{id} and GET /app/latest-release (no release) both return 204 No
  // Content — res.json() throws on an empty body.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
