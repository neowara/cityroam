// fetch() has no default timeout on React Native — a flaky/weak connection made a trip
// upload hang instead of failing, with nothing for saveAndSyncTrip to catch and queue
// for retry. client.ts's request() now bounds every call with an AbortController.

import { request, setUseCustomServer, setServerAddress } from '@/lib/api/client';

describe('client.ts request() timeout', () => {
  beforeEach(async () => {
    await setUseCustomServer(true);
    await setServerAddress('https://backend.example.com');
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts a hung request after the timeout and rejects with a clear message', async () => {
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
        }),
    );

    const assertion = expect(request('/trips')).rejects.toThrow(/timed out after 20s/);
    await jest.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('passes an AbortSignal to fetch, so a real hang can actually be cancelled', async () => {
    let capturedSignal: AbortSignal | undefined;
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return new Promise(() => {}); // never resolves — only the abort should ever end this
    });

    request('/trips').catch(() => {});
    // Lets request()'s own chain of awaits (getServerAddress, getSessionToken) actually
    // reach fetch() — a plain microtask flush isn't enough since those go through the
    // mocked AsyncStorage/SecureStore, not straight-line promises.
    await jest.advanceTimersByTimeAsync(0);

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('does not leave the timeout timer running past a request that resolves normally', async () => {
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true }),
    });

    await request('/health');

    // If the timeout weren't cleared, advancing past it here would still be harmless in
    // isolation, but a leaked timer is exactly what trips Jest's real-timer open-handle
    // detection elsewhere in this suite — asserting the timer count is the direct check.
    expect(jest.getTimerCount()).toBe(0);
  });
});
