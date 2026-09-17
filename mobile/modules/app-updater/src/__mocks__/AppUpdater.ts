// Jest has no real native module registry for a local custom module — same reasoning
// as board-ble's own mock, mapped in via package.json's jest.moduleNameMapper.
export default {
  canRequestPackageInstalls: () => true,
  openInstallPermissionSettings: () => Promise.resolve(),
  installedVersionCode: () => 1,
  verifyApk: () => Promise.resolve({ ok: false, reason: 'unreadable' }),
  installApk: () => Promise.reject(new Error('not mocked')),
  addListener: () => ({ remove: () => {} }),
  removeAllListeners: () => {},
};
