// Jest has no native module registry for local custom modules — same pattern as
// board-ble's mock, mapped via package.json jest.moduleNameMapper.
export default {
  captcha: () => Promise.reject(new Error('not mocked')),
  signIn: () => Promise.reject(new Error('not mocked')),
  listVehicles: () => Promise.resolve([]),
  isSignedIn: () => false,
  signedInUserId: () => null,
  signOut: () => {},
  scan: () => Promise.resolve(null),
  stopScan: () => {},
  connectDirect: () => {},
  disconnectDirect: () => {},
  reconnectNow: () => {},
  connectionPhase: () => null,
  isDirectConnected: () => false,
  recentDiagnostics: () => [],
  startBackgroundReconnect: () => {},
  stopBackgroundReconnect: () => {},
  queryDpsDirect: () => Promise.reject(new Error('not mocked')),
  writeSetting: () => Promise.reject(new Error('not mocked')),
  addListener: () => ({ remove: () => {} }),
  removeAllListeners: () => {},
};
