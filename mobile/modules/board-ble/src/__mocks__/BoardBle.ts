// Jest has no real native module registry for a local custom module — same reasoning
// as tuya-ble's own mock, mapped in via package.json's jest.moduleNameMapper.
export default {
  connectDirect: () => {},
  disconnectDirect: () => {},
  reconnectNow: () => {},
  connectionPhase: () => null,
  recentDiagnostics: () => [],
  getIdleConnectStrategy: () => 'scan_then_direct',
  setIdleConnectStrategy: () => {},
  startBackgroundReconnect: () => {},
  stopBackgroundReconnect: () => {},
  isDirectConnected: () => false,
  publishDpDirect: () => Promise.reject(new Error('not mocked')),
  queryDpsDirect: () => Promise.reject(new Error('not mocked')),
  signIn: () => Promise.reject(new Error('not mocked')),
  listDevices: () => Promise.resolve([]),
  fetchKeys: () => Promise.reject(new Error('not mocked')),
  signOut: () => {},
  isSignedInToTuya: () => false,
  addListener: () => ({ remove: () => {} }),
  removeAllListeners: () => {},
};
