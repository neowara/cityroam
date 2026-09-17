// client.ts's request() must clear the stored session token and notify
// subscribers the instant a 401 comes back from any endpoint, so a signed-out user
// can never keep silently hammering a dead token (see lib/auth.ts's onSessionExpired
// listener, which is what actually flips the app-level guard).

import { request, setSessionToken, getSessionToken, onSessionExpired, setUseCustomServer, setServerAddress } from '@/lib/api/client';

describe('client.ts request() 401 handling', () => {
  beforeEach(async () => {
    await setUseCustomServer(true);
    await setServerAddress('https://backend.example.com');
    await setSessionToken('some-token');
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('clears the stored session token on a 401 response', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"detail":"invalid or expired token"}',
    });

    await expect(request('/trips')).rejects.toThrow('401');
    expect(await getSessionToken()).toBeNull();
  });

  it('notifies onSessionExpired listeners on a 401 response', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '{"detail":"invalid or expired token"}',
    });

    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);
    try {
      await expect(request('/trips')).rejects.toThrow('401');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('does not touch the session token on a non-401 error (e.g. 500)', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });

    await expect(request('/trips')).rejects.toThrow('500');
    expect(await getSessionToken()).toBe('some-token');
  });

  it('attaches the stored session token as a Bearer header', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true }),
    });

    await request('/health');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer some-token');
  });
});
