const { withAppBuildGradle } = require('@expo/config-plugins');

// AGP's bundled ninja does not support long paths, and :app's autolinked native build
// aggregates codegen sources from every native module (gesture-handler, RNCSlider,
// rnscreens, ...) into its own .cxx staging directory. Nested under a real project path,
// those generated object file paths exceed Windows' 260-character limit and ninja fails
// with "Filename longer than 260 characters". Relocating one module's own cmake config
// does not help: :app's aggregated staging directory is the one holding the deep
// node_modules paths, so it is the one that needs a short path. C:/app-cxx is short and
// stable, and this is a build-machine-local workaround rather than something that has to
// match between machines.
module.exports = function withWindowsMaxPathWorkaround(config) {
  if (process.platform !== 'win32') return config;

  return withAppBuildGradle(config, (config) => {
    if (config.modResults.contents.includes('C:/app-cxx')) return config;
    config.modResults.contents = config.modResults.contents.replace(
      /(namespace 'com\.neowara\.cityroam')/,
      `$1
    externalNativeBuild {
        cmake {
            buildStagingDirectory "C:/app-cxx"
        }
    }`
    );
    return config;
  });
};
