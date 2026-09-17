// The app-update endpoints are public (no login), so requestPublic must never attach a
// stale or absent session token and must never risk client-session.test.ts's own
// 401-clears-session path — an update check that could sign a rider out would defeat the
// point of it being reachable while signed out or midway through a broken login.

import {
  getSessionToken,
  onSessionExpired,
  request,
  requestPublic,
  setServerAddress,
  setSessionToken,
  setUseCustomServer,
} from '@/lib/api/client';

describe('client.ts requestPublic', () => {
  beforeEach(async () => {
    await setUseCustomServer(true);
    await setServerAddress('https://backend.example.com');
    await setSessionToken('some-real-token');
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn();
  });

  it('never attaches a Bearer token, even when one is stored', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await requestPublic('/app/latest-release');

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('a 401 does not clear the stored session token or notify onSessionExpired', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '',
    });
    const listener = jest.fn();
    const unsubscribe = onSessionExpired(listener);

    await expect(requestPublic('/app/latest-release')).rejects.toThrow('401');

    expect(await getSessionToken()).toBe('some-real-token');
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('request (the authenticated variant) still clears the session on a real 401 — guards against requestPublic silently becoming the default', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => '',
    });

    await expect(request('/trips')).rejects.toThrow('401');

    expect(await getSessionToken()).toBeNull();
  });

  it('treats a 204 as "no release" rather than throwing on an empty body', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 204 });

    await expect(requestPublic('/app/latest-release')).resolves.toBeUndefined();
  });
});
