import { GeocodingError, searchAddress } from '@/features/planner/geocoding';

function setFetchMock(mock: jest.Mock) {
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mock;
}

function mockFetchOnce(response: Partial<Response> & { json: () => Promise<unknown> }) {
  setFetchMock(jest.fn().mockResolvedValue(response));
}

function feature(
  coordinates: [number, number],
  properties: { name?: string; street?: string; housenumber?: string; city?: string; state?: string; country?: string },
) {
  return { properties, geometry: { coordinates } };
}

describe('searchAddress', () => {
  it('throws for an empty query without making a request', async () => {
    const fetchMock = jest.fn();
    setFetchMock(fetchMock);
    await expect(searchAddress('   ')).rejects.toThrow(GeocodingError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns every valid result, most relevant first, for a pick list', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        features: [
          feature([11.9746, 57.7089], { name: 'Gothenburg', country: 'Sweden' }),
          feature([-71.0589, 42.3601], { name: 'Gothenburg', state: 'Massachusetts', country: 'USA' }),
        ],
      }),
    } as Response);

    const results = await searchAddress('Gothenburg');
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ lat: 57.7089, lon: 11.9746, displayName: 'Gothenburg, Sweden' });
    expect(results[1].displayName).toBe('Gothenburg, Massachusetts, USA');
  });

  it('builds the display name from a street + housenumber when present', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        features: [feature([11.9746, 57.7089], { street: 'Kungsgatan', housenumber: '12', city: 'Göteborg', country: 'Sweden' })],
      }),
    } as Response);

    const results = await searchAddress('Kungsgatan 12');
    expect(results[0].displayName).toBe('Kungsgatan 12, Göteborg, Sweden');
  });

  it('drops results with unparseable coordinates rather than throwing', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        features: [
          { properties: { name: 'Bad result' }, geometry: { coordinates: [11.9746, NaN] } },
          feature([11.9746, 57.7089], { name: 'Good result' }),
        ],
      }),
    } as Response);

    const results = await searchAddress('somewhere');
    expect(results).toHaveLength(1);
    expect(results[0].displayName).toBe('Good result');
  });

  it('drops a result with no usable address fields at all', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ features: [{ properties: {}, geometry: { coordinates: [11.9746, 57.7089] } }] }),
    } as Response);

    await expect(searchAddress('somewhere')).rejects.toThrow(GeocodingError);
  });

  it('throws when nothing matches', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ features: [] }) } as Response);
    await expect(searchAddress('asdkfjasldkfj')).rejects.toThrow(GeocodingError);
  });

  it('throws a friendly error when the request itself fails', async () => {
    setFetchMock(jest.fn().mockRejectedValue(new Error('network down')));
    await expect(searchAddress('somewhere')).rejects.toThrow(GeocodingError);
  });

  it('throws a friendly error on a non-OK response', async () => {
    mockFetchOnce({ ok: false, json: async () => ({}) } as Response);
    await expect(searchAddress('somewhere')).rejects.toThrow(GeocodingError);
  });
});
