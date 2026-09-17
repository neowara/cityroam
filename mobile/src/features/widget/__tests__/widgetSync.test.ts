// Verifies the widget snapshot builder folds the trip recorder's live snapshot together
// with the BLE session's board telemetry into the compact JSON the native widget renders.
//
// widgetSync.ts runs side effects at module scope (it subscribes to the recorder and the
// BLE session on import), and those subscriptions invoke the mocked modules immediately.
// ES `import` is hoisted above the `const` mock declarations, so importing widgetSync at
// the top of the file would hit the mocks while they're still in the temporal dead zone.
// Requiring it lazily inside beforeAll runs after the top-level consts are initialized.

const mockGetSnapshot = jest.fn();
const mockSubscribe = jest.fn();
const mockGetBleSessionState = jest.fn();
const mockGetCachedDps = jest.fn();
const mockGetPairedDeviceId = jest.fn().mockResolvedValue(null);
const mockSubscribeBleSession = jest.fn();
const mockSubscribeToBleConnectionTransitions = jest.fn().mockReturnValue(() => {});
const mockUpdateSnapshot = jest.fn();

jest.mock('@/features/rides/tripRecorder', () => ({
  tripRecorder: {
    getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
    subscribe: (listener: () => void) => mockSubscribe(listener) as () => void,
  },
}));

jest.mock('@/features/device/deviceLink/session', () => ({
  getBleSessionState: (...args: unknown[]) => mockGetBleSessionState(...args),
  getCachedDps: (...args: unknown[]) => mockGetCachedDps(...args),
}));

jest.mock('@/features/device/deviceLink', () => ({
  getPairedDeviceId: (...args: unknown[]) => mockGetPairedDeviceId(...args),
  subscribeBleSession: (devId: string, listener: (s: unknown) => void) => mockSubscribeBleSession(devId, listener) as () => void,
  subscribeToBleConnectionTransitions: (...args: unknown[]) => mockSubscribeToBleConnectionTransitions(...args),
}));

jest.mock('@modules/cityroam-widget/src/CityroamWidget', () => ({
  __esModule: true,
  default: { updateSnapshot: (...args: unknown[]) => mockUpdateSnapshot(...args) },
}));

function recorderSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    state: 'idle',
    tripStartEpochMs: 0,
    elapsedSec: 0,
    distanceKm: 0,
    currentSpeedKmh: 0,
    maxSpeedKmh: 0,
    batteryStartPct: null,
    modesUsed: [],
    route: [],
    lastSaveResult: null,
    startBlockedReason: null,
    powerSaveModeOn: false,
    ...overrides,
  };
}

describe('buildWidgetSnapshotJson', () => {
  let buildWidgetSnapshotJson: () => string;

  beforeAll(() => {
    // Lazy require — see the header comment for why this can't be a top-level import.
    ({ buildWidgetSnapshotJson } = require('@/features/widget/widgetSync'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSnapshot.mockReturnValue(recorderSnapshot());
    mockGetBleSessionState.mockReturnValue({ online: null, charging: null, dpsLive: false });
    mockGetCachedDps.mockReturnValue(null);
  });

  it('emits an idle snapshot with null board telemetry when nothing is connected', () => {
    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed).toEqual({
      state: 'idle',
      tripStartEpochMs: 0,
      elapsedSec: 0,
      currentSpeedKmh: null,
      distanceKm: 0,
      maxSpeedKmh: 0,
      batteryPct: null,
      charging: null,
      online: null,
      mode: null,
      odometerKm: null,
      hasLastRide: false,
      lastRideDistanceKm: 0,
      lastRideDurationSec: 0,
      lastRideMaxSpeedKmh: 0,
      lastRideAvgSpeedKmh: 0,
      lastRideBatteryUsedPct: null,
      lastRideEndEpochMs: 0,
      lastRideStopsCount: 0,
      lastRideOdometerKm: null,
      lastRideWeatherTempC: null,
      lastRideWeatherWindMs: null,
      lastRideWeatherCode: null,
      lastRideTripId: null,
      ecoBatteryPct: null,
      rideBatteryPct: null,
      speedBatteryPct: null,
      turboBatteryPct: null,
      weatherTempC: null,
      weatherWindMs: null,
      weatherCode: null,
      accentColor: '#f5793a', // default Ember accent
      font: 'dash',
      needle: 'accent',
      containerStyle: 'matte',
    });
  });

  it("reflects the widget's own needle choice, independent of its default", () => {
    const { setWidgetNeedle } = require('@/features/widget/widgetAppearance');
    setWidgetNeedle('ink');
    try {
      expect(JSON.parse(buildWidgetSnapshotJson()).needle).toBe('ink');
    } finally {
      setWidgetNeedle('accent'); // restore the default so later tests in this file aren't order-dependent
    }
  });

  it('folds a live ride + board telemetry into the snapshot', () => {
    mockGetSnapshot.mockReturnValue(
      recorderSnapshot({
        state: 'riding',
        tripStartEpochMs: 1_700_000_000_000,
        elapsedSec: 125,
        distanceKm: 1.2,
        currentSpeedKmh: 18,
        maxSpeedKmh: 32,
      }),
    );
    mockGetBleSessionState.mockReturnValue({ online: true, charging: false, dpsLive: true });
    // dp2 speed is scale-1 (raw = km/h * 10); dp3 battery is a raw percentage; dp14 is the mode.
    mockGetCachedDps.mockReturnValue({ '2': 245, '3': 80, '14': 'level_3' });

    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed).toEqual({
      state: 'riding',
      tripStartEpochMs: 1_700_000_000_000,
      elapsedSec: 125,
      currentSpeedKmh: 24.5, // the board's own dp2 wheel speed, not the recorder's derived reading
      distanceKm: 1.2,
      maxSpeedKmh: 32,
      batteryPct: 80,
      charging: false,
      online: true,
      mode: 'Speed', // level_3 decodes to the canonical 'speed' mode, labelled "Speed"
      odometerKm: null,
      hasLastRide: false,
      lastRideDistanceKm: 0,
      lastRideDurationSec: 0,
      lastRideMaxSpeedKmh: 0,
      lastRideAvgSpeedKmh: 0,
      lastRideBatteryUsedPct: null,
      lastRideEndEpochMs: 0,
      lastRideStopsCount: 0,
      lastRideOdometerKm: null,
      lastRideWeatherTempC: null,
      lastRideWeatherWindMs: null,
      lastRideWeatherCode: null,
      lastRideTripId: null,
      ecoBatteryPct: null,
      rideBatteryPct: null,
      speedBatteryPct: null,
      turboBatteryPct: null,
      weatherTempC: null,
      weatherWindMs: null,
      weatherCode: null,
      accentColor: '#f5793a',
      font: 'dash',
      needle: 'accent',
      containerStyle: 'matte',
    });
  });

  it("falls back to the recorder's board-speed reading when the board has sent no dp2 value yet", () => {
    mockGetSnapshot.mockReturnValue(recorderSnapshot({ state: 'riding', currentSpeedKmh: 18, maxSpeedKmh: 32 }));
    mockGetBleSessionState.mockReturnValue({ online: true, charging: null, dpsLive: true });
    mockGetCachedDps.mockReturnValue({ '3': 60 });

    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed.currentSpeedKmh).toBe(18);
    expect(parsed.batteryPct).toBe(60);
    expect(parsed.charging).toBeNull();
  });

  // The DP map is also hydrated from AsyncStorage at startup, so a populated map on its
  // own proves nothing about the board being present — those values can be days old.
  it('reports no board telemetry when the dps came from disk rather than a live push', () => {
    mockGetSnapshot.mockReturnValue(recorderSnapshot({ state: 'riding', currentSpeedKmh: 0 }));
    mockGetBleSessionState.mockReturnValue({ online: true, charging: null, dpsLive: false });
    mockGetCachedDps.mockReturnValue({ '2': 245, '3': 80, '12': 7496, '14': 'level_3' });

    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed.currentSpeedKmh).toBeNull();
    expect(parsed.batteryPct).toBeNull();
    expect(parsed.mode).toBeNull();
    expect(parsed.odometerKm).toBeNull();
    // Distance/max-speed are board telemetry too (dp2's running totals) — nulled the same
    // way current speed is, not left showing whatever the recorder happened to accumulate
    // before the board went quiet.
    expect(parsed.distanceKm).toBeNull();
    expect(parsed.maxSpeedKmh).toBeNull();
  });

  // `online` stays null until the first status event or push lands — the exact window in
  // which the only values available are the hydrated ones.
  it('reports no board telemetry while the link is not yet confirmed online', () => {
    mockGetSnapshot.mockReturnValue(recorderSnapshot({ state: 'riding', currentSpeedKmh: 0 }));
    mockGetBleSessionState.mockReturnValue({ online: null, charging: null, dpsLive: true });
    mockGetCachedDps.mockReturnValue({ '2': 245, '3': 80, '12': 7496 });

    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed.currentSpeedKmh).toBeNull();
    expect(parsed.batteryPct).toBeNull();
    expect(parsed.odometerKm).toBeNull();
    expect(parsed.distanceKm).toBeNull();
    expect(parsed.maxSpeedKmh).toBeNull();
  });

  it("reports the board's live odometer only while it is genuinely reporting", () => {
    mockGetSnapshot.mockReturnValue(recorderSnapshot());
    mockGetBleSessionState.mockReturnValue({ online: true, charging: null, dpsLive: true });
    mockGetCachedDps.mockReturnValue({ '12': 7496 });

    expect(JSON.parse(buildWidgetSnapshotJson()).odometerKm).toBe(749.6);
  });

  // Idle isn't gated on board presence at all — those fields aren't read by the native
  // side for the idle view (it reads the separate lastRide* fields instead), and the
  // recorder's own idle values (both 0 here, same as recorderSnapshot's default) should
  // pass through unchanged rather than being nulled for no reason.
  it('does not null distance/max-speed while idle, regardless of board state', () => {
    mockGetSnapshot.mockReturnValue(recorderSnapshot({ state: 'idle' }));
    mockGetBleSessionState.mockReturnValue({ online: false, charging: null, dpsLive: false });
    mockGetCachedDps.mockReturnValue(null);

    const parsed = JSON.parse(buildWidgetSnapshotJson());
    expect(parsed.distanceKm).toBe(0);
    expect(parsed.maxSpeedKmh).toBe(0);
  });
});
