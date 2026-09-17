// refreshLiveWeatherIfNeeded stamped its "fetched for this key" cooldown
// *before* the fetch resolved, and never reset it on failure — a single rejected or
// empty fetch (e.g. no signal for the one GPS sample that triggered it) silently
// blocked every retry for the full 15-minute refresh window, most of a typical ride,
// even once connectivity came back.

const mockFetchCurrentWeather = jest.fn();

jest.mock('@/lib/weather', () => ({
  fetchCurrentWeather: (lat: number, lon: number) => mockFetchCurrentWeather(lat, lon),
}));

import { clearCachedLiveWeather, getCachedLiveWeather, refreshLiveWeatherIfNeeded } from '@/features/widget/widgetExtras';

describe('refreshLiveWeatherIfNeeded', () => {
  beforeEach(() => {
    mockFetchCurrentWeather.mockReset();
    clearCachedLiveWeather();
  });

  it('caches a successful result and skips refetching the same key inside the refresh window', async () => {
    mockFetchCurrentWeather.mockResolvedValue({ weatherCode: 0, feelsLikeC: 18, windSpeedMs: 2 });

    await refreshLiveWeatherIfNeeded(57.7, 11.9);
    expect(getCachedLiveWeather()).toEqual({ weatherCode: 0, feelsLikeC: 18, windSpeedMs: 2 });

    await refreshLiveWeatherIfNeeded(57.7, 11.9);
    expect(mockFetchCurrentWeather).toHaveBeenCalledTimes(1);
  });

  it('retries immediately after a rejected fetch instead of waiting out the refresh window', async () => {
    mockFetchCurrentWeather.mockRejectedValueOnce(new Error('network down'));
    await refreshLiveWeatherIfNeeded(57.7, 11.9);
    expect(getCachedLiveWeather()).toBeNull();

    mockFetchCurrentWeather.mockResolvedValueOnce({ weatherCode: 61, feelsLikeC: 14, windSpeedMs: 5 });
    await refreshLiveWeatherIfNeeded(57.7, 11.9);

    expect(mockFetchCurrentWeather).toHaveBeenCalledTimes(2);
    expect(getCachedLiveWeather()).toEqual({ weatherCode: 61, feelsLikeC: 14, windSpeedMs: 5 });
  });

  it('retries immediately after a resolved-but-empty fetch (fetchCurrentWeather returns null on a non-ok response)', async () => {
    mockFetchCurrentWeather.mockResolvedValueOnce(null);
    await refreshLiveWeatherIfNeeded(57.7, 11.9);
    expect(getCachedLiveWeather()).toBeNull();

    mockFetchCurrentWeather.mockResolvedValueOnce({ weatherCode: 3, feelsLikeC: 10, windSpeedMs: 1 });
    await refreshLiveWeatherIfNeeded(57.7, 11.9);

    expect(mockFetchCurrentWeather).toHaveBeenCalledTimes(2);
    expect(getCachedLiveWeather()).toEqual({ weatherCode: 3, feelsLikeC: 10, windSpeedMs: 1 });
  });

  it('joins an in-flight fetch for the same key instead of firing a duplicate request', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    mockFetchCurrentWeather.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)));

    const first = refreshLiveWeatherIfNeeded(57.7, 11.9);
    const second = refreshLiveWeatherIfNeeded(57.7, 11.9);
    resolveFetch({ weatherCode: 0, feelsLikeC: 20, windSpeedMs: 1 });
    await Promise.all([first, second]);

    expect(mockFetchCurrentWeather).toHaveBeenCalledTimes(1);
  });

  it("a different location key fetches independently, not gated by the first key's cooldown", async () => {
    mockFetchCurrentWeather.mockResolvedValue({ weatherCode: 0, feelsLikeC: 18, windSpeedMs: 2 });

    await refreshLiveWeatherIfNeeded(57.7, 11.9);
    await refreshLiveWeatherIfNeeded(55.6, 13.0);

    expect(mockFetchCurrentWeather).toHaveBeenCalledTimes(2);
  });
});
