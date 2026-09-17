// Verifies widgetSync subscribes to the widget's own appearance changes (independent of
// the app's theme — see widgetAppearance.ts) and re-pushes the snapshot when it changes,
// so the widget's view reflects the new look immediately instead of waiting for an
// unrelated push.
//
// widgetAppearance is mocked here so we can capture the listener widgetSync registers on
// import and drive it directly.

const mockGetSnapshot = jest.fn();
const mockSubscribe = jest.fn();
const mockGetBleSessionState = jest.fn();
const mockGetCachedDps = jest.fn();
const mockGetPairedDeviceId = jest.fn().mockResolvedValue(null);
const mockSubscribeBleSession = jest.fn();
const mockSubscribeToBleConnectionTransitions = jest.fn().mockReturnValue(() => {});
const mockUpdateSnapshot = jest.fn();
const mockSubscribeToWidgetAppearance = jest.fn();
const mockLoadWidgetAppearance = jest.fn().mockResolvedValue(undefined);
const mockGetWidgetAccentColor = jest.fn();
const mockGetWidgetFont = jest.fn();
const mockGetWidgetNeedle = jest.fn();
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
  subscribeToBleConnectionTransitions: (...args: unknown[]) => mockSubscribeToBleConnectionTransitions(...args),
}));

jest.mock('@modules/cityroam-widget/src/CityroamWidget', () => ({
  __esModule: true,
  default: { updateSnapshot: (...args: unknown[]) => mockUpdateSnapshot(...args) },
}));

jest.mock('@/features/widget/widgetAppearance', () => ({
  getWidgetAccentColor: (...args: unknown[]) => mockGetWidgetAccentColor(...args),
  getWidgetFont: (...args: unknown[]) => mockGetWidgetFont(...args),
  getWidgetNeedle: (...args: unknown[]) => mockGetWidgetNeedle(...args),
  getWidgetContainerStyle: () => 'matte',
  loadWidgetAppearance: (...args: unknown[]) => mockLoadWidgetAppearance(...args),
  subscribeToWidgetAppearance: (...args: unknown[]) => mockSubscribeToWidgetAppearance(...args),
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

describe('widgetSync appearance re-push', () => {
  let appearanceListener: (() => void) | null = null;

  beforeAll(() => {
    mockSubscribeToWidgetAppearance.mockImplementation((listener: () => void) => {
      appearanceListener = listener;
      return () => {
        appearanceListener = null;
      };
    });
    // Lazy require — see widgetSync.test.ts's header comment for why this can't be a
    // top-level import (module-scope side effects run against mocks in the TDZ).
    require('@/features/widget/widgetSync');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSnapshot.mockReturnValue(recorderSnapshot());
    mockGetBleSessionState.mockReturnValue({ online: null, charging: null });
    mockGetCachedDps.mockReturnValue(null);
    mockGetLastRide.mockReturnValue(null);
    mockGetWidgetAccentColor.mockReturnValue('#f5793a');
    mockGetWidgetFont.mockReturnValue('dash');
    mockGetWidgetNeedle.mockReturnValue('accent');
  });

  it('registers a widget-appearance-change listener on import', () => {
    // The registration call happened during the beforeAll require, but beforeEach's
    // clearAllMocks wipes that call history — what matters is that the listener was
    // captured and is still wired up.
    expect(appearanceListener).not.toBeNull();
  });

  it('re-pushes the snapshot when the widget appearance changes', () => {
    mockUpdateSnapshot.mockClear();
    appearanceListener!();
    expect(mockUpdateSnapshot).toHaveBeenCalledTimes(1);
    // The pushed snapshot reflects the (now-updated) accent/font.
    const pushed = JSON.parse(mockUpdateSnapshot.mock.calls[0][0]);
    expect(pushed.accentColor).toBe('#f5793a');
    expect(pushed.font).toBe('dash');
    expect(pushed.needle).toBe('accent');
  });
});
