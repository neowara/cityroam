// Jest has no real native module registry for a local custom module — same reasoning
// as board-ble's own mock, mapped in via package.json's jest.moduleNameMapper.
export default {
  start: () => {},
  stop: () => {},
  isRunning: () => false,
  hasLocationForeground: () => false,
  getStitchWindowMs: () => 60_000,
  setStitchWindowMs: () => {},
  getActiveRide: () => null,
  listFinishedRides: () => [],
  getRide: () => null,
  getRideSamples: () => ({ gps: [], board: [], events: [] }),
  markRideUploaded: () => {},
};
