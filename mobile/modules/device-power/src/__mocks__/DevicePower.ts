// Jest has no real native module registry — jest-expo mocks known Expo SDK packages
// out of the box, but this is a local custom module it's never heard of, so
// requireNativeModule('DevicePower') throws at import time otherwise. Mapped in via
// package.json's jest.moduleNameMapper, same pattern already used there for
// @react-native-async-storage/async-storage's own official jest mock.
export default {
  isIgnoringBatteryOptimizations: () => false,
  requestIgnoreBatteryOptimizations: () => Promise.resolve(),
  isPowerSaveModeOn: () => false,
  networkCountryIso: () => null,
};
