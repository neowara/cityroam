import { request } from '@/lib/api/client';

// GET /health is the one backend route that stays at the root, unversioned and
// unauthenticated — `request`'s ROOT_PATHS allow-list keeps it unprefixed.
export const healthApi = {
  health: () => request<{ status: string }>('/health'),
};
