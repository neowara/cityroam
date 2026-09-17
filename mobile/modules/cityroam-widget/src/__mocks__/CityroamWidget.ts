// Jest has no real native module registry — jest-expo mocks known Expo SDK packages
// out of the box, but this is a local custom module it's never heard of, so
// requireNativeModule('CityroamWidget') throws at import time otherwise. Mapped in via
// package.json's jest.moduleNameMapper, same pattern already used there for the other
// local modules (BoardBle, DevicePower).
export default {
  updateSnapshot: () => {},
  renderPreview: () => Promise.resolve(''),
};
