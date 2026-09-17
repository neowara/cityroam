// Verifies widgetSync subscribes directly to BLE connect/disconnect transitions (the same
// event bus tripRecorder.ts uses for its own reactive logic — startConnectionGatedTracking,
// handleBleConnectionTransition) and re-pushes the snapshot on both, so the widget's header
// (state dot/label) and live numbers (distance/max/avg, gated on the board reporting) swap
// the instant a transition happens rather than waiting for some other trigger to next fire.
//
// deviceLink is mocked here so we can capture the listener widgetSync registers on import
// and drive it directly.

const mockGetSnapshot = jest.fn();
const mockSubscribe = jest.fn();
const mockGetBleSessionState = jest.fn();
const mockGetCachedDps = jest.fn();
const mockGetPairedDeviceId = jest.fn().mockResolvedValue(null);
const mockSubscribeBleSession = jest.fn();
const mockSubscribeToBleConnectionTransitions = jest.fn();
const mockUpdateSnapshot = jest.fn();
const mockLoadWidgetContext = jest.fn().mockResolvedValue(undefined);
const mockGetLastRide = jest.fn();
const mockOnLastRideCaptured = jest.fn();

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
}));

// Mocked at the events module, which is where widgetSync subscribes: going through
// lib/deviceLink's re-export would put the subscriber on a different instance from the
// emitter, since that module is in a require cycle.
jest.mock('@/features/device/deviceLink/connectionEvents', () => ({
  subscribeToBleConnectionTransitions: (...args: unknown[]) => mockSubscribeToBleConnectionTransitions(...args),
}));

jest.mock('@modules/cityroam-widget/src/CityroamWidget', () => ({
  __esModule: true,
  default: { updateSnapshot: (...args: unknown[]) => mockUpdateSnapshot(...args) },
}));

jest.mock('@/features/widget/widgetAppearance', () => ({
  getWidgetAccentColor: () => '#f5793a',
  getWidgetFont: () => 'dash',
  getWidgetNeedle: () => 'accent',
  getWidgetContainerStyle: () => 'matte',
  loadWidgetAppearance: () => Promise.resolve(),
  subscribeToWidgetAppearance: () => () => {},
}));

jest.mock('@/features/widget/widgetLastRide', () => ({
  getLastRide: (...args: unknown[]) => mockGetLastRide(...args),
  loadWidgetContext: (...args: unknown[]) => mockLoadWidgetContext(...args),
  onLastRideCaptured: (...args: unknown[]) => mockOnLastRideCaptured(...args),
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

describe('widgetSync connection-transition re-push', () => {
  let connectionListener: ((event: { type: 'connected' | 'disconnected' }) => void) | null = null;

  beforeAll(() => {
    mockSubscribeToBleConnectionTransitions.mockImplementation((listener: (event: { type: 'connected' | 'disconnected' }) => void) => {
      connectionListener = listener;
      return () => {
        connectionListener = null;
      };
    });
    // Lazy require — see widgetSync.test.ts's header comment for why this can't be a
    // top-level import (module-scope side effects run against mocks in the TDZ).
    require('@/features/widget/widgetSync');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSnapshot.mockReturnValue(recorderSnapshot());
    mockGetBleSessionState.mockReturnValue({ online: null, charging: null, dpsLive: false });
    mockGetCachedDps.mockReturnValue(null);
    mockGetLastRide.mockReturnValue(null);
  });

  it('registers a connection-transition listener on import', () => {
    // The registration call happened during the beforeAll require, but beforeEach's
    // clearAllMocks wipes that call history — what matters is that the listener was
    // captured and is still wired up.
    expect(connectionListener).not.toBeNull();
  });

  it('re-pushes the snapshot on a connect transition', () => {
    connectionListener!({ type: 'connected' });
    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('re-pushes the snapshot on a disconnect transition', () => {
    connectionListener!({ type: 'disconnected' });
    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1);
  });
});
