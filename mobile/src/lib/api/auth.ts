import { request } from '@/lib/api/client';

// backend auth rewrite — replaces the old shared static API_TOKEN with
// real per-user accounts (email/password login, DB-backed session token). No
// public signup endpoint exists or ever will — accounts are admin-issued only.
export type LoginResponse = { token: string; userId: number; email: string };

// GET /auth/me — the caller's account,
// extended with the persisted last-known rider weight and the account-level
// product-family allow-list. productFamilies defaults to ["tynee"] server-side.
export type MeResponse = {
  userId: number;
  email: string;
  riderWeightKg: number | null;
  riderWeightUpdatedAt: string | null;
  productFamilies: string[];
};

export const authApi = {
  login: (email: string, password: string) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  // Best-effort server-side revoke — callers should still clear the local session
  // regardless of whether this succeeds (no network, already-expired token, etc).
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<MeResponse>('/auth/me'),
  // Persist the caller's last-known rider weight (kg) so estimates stay correct even
  // when Health Connect is unavailable at request time. null clears it.
  putWeight: (riderWeightKg: number | null) =>
    request<MeResponse>('/auth/me/weight', { method: 'PUT', body: JSON.stringify({ riderWeightKg }) }),
  // Set the account-level product-family allow-list (Tynee/NAVEE). Unknown
  // families are dropped server-side; an empty list defaults back to ["tynee"].
  putFamilies: (productFamilies: string[]) =>
    request<MeResponse>('/auth/me/families', { method: 'PUT', body: JSON.stringify({ productFamilies }) }),
};
