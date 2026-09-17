// Multibrand catalog — the catalog picker must
// request the catalog filtered by the selected device's brand so a Tynee device only
// ever shows Tynee boards and a NAVEE device only NAVEE boards. These tests pin the
// brand query param that devicesApi.getBoardCatalog builds, and that omitting the brand
// (a legacy/custom device) requests the full catalog.

import { setUseCustomServer, setServerAddress, setSessionToken } from '@/lib/api/client';
import { DEFAULT_BRAND, devicesApi, PRODUCT_FAMILIES } from '@/lib/api/devices';

describe('devicesApi.getBoardCatalog brand filter', () => {
  beforeEach(async () => {
    await setUseCustomServer(true);
    await setServerAddress('https://backend.example.com');
    await setSessionToken('some-token');
    (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ catalog: [] }),
    });
  });

  it('appends the brand query param when a brand is given', async () => {
    await devicesApi.getBoardCatalog('tynee');

    const url = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/devices/catalog?brand=tynee');
  });

  it('requests the full catalog (no brand filter) when brand is omitted', async () => {
    await devicesApi.getBoardCatalog();

    const url = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('/api/v1/devices/catalog');
    expect(url).not.toContain('brand=');
  });

  it('URL-encodes the brand value', async () => {
    await devicesApi.getBoardCatalog('navee');

    const url = (globalThis.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('?brand=navee');
  });
});

// Code-review finding (primitive obsession / duplicated 'tynee' default): the brand a
// legacy or Tuya-BLE-paired device is assumed to be is a single shared constant, not a
// magic string duplicated across deviceLink and the settings pairing gate. It must be a
// real product-family key so it can never drift from the catalog's brand vocabulary.
describe('DEFAULT_BRAND (code-review finding: shared brand constant)', () => {
  it("is 'tynee' — the only brand the Tuya BLE pairing path can produce", () => {
    expect(DEFAULT_BRAND).toBe('tynee');
  });

  it('is a real product-family key (never drifts from the catalog brand vocabulary)', () => {
    expect(PRODUCT_FAMILIES).toHaveProperty(DEFAULT_BRAND);
  });
});
