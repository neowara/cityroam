const { withAppBuildGradle } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Release builds run through `./gradlew assembleRelease` rather than `eas build`, so the
// release signingConfig has to be wired in here. Expo's generated build.gradle signs
// `release` with the *debug* keystore by default, and a build signed with a different key
// cannot install over an already-installed copy: Android treats a different signature as a
// different app, so every rider would have to uninstall first.
//
// `credentials.json` (exported with `eas credentials -p android`) holds the real keystore's
// path and key alias. It is gitignored because it also carries passwords, and this plugin
// reads only the path and alias, never the passwords.
//
// The generated build.gradle resolves the passwords at Gradle configuration time from
// TURBO_STORE_PASSWORD / TURBO_KEY_PASSWORD, or failing those from the gitignored
// mobile/keystore.properties. Nothing plaintext reaches the generated file, and a release
// build without either source fails with a descriptive GradleException instead of silently
// signing with the debug key.
//
// A machine with no credentials.json (local dev-client work rather than a release) gets the
// ordinary debug-signed release build unchanged.
module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    const credentialsPath = path.join(config.modRequest.projectRoot, 'credentials.json');
    if (!fs.existsSync(credentialsPath)) return config;

    const { android } = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    if (!android?.keystore) return config;

    const { keystorePath, keyAlias } = android.keystore;
    if (!keystorePath || !keyAlias) return config;

    const absoluteKeystorePath = path
      .resolve(config.modRequest.projectRoot, keystorePath)
      .replace(/\\/g, '\\\\');

    // Password resolution injected into the android {} block, right before
    // signingConfigs, so the turboStorePassword/turboKeyPassword locals are in scope
    // for the signingConfig.release block below (nested Groovy closures capture the
    // enclosing android {} block's locals). Throws a descriptive GradleException when
    // both sources are absent AND a release-type task is actually being run — this
    // whole android {} block configures every build type regardless of which task
    // gradle was invoked with, so without the task-name guard a plain debug build
    // (the normal local dev loop) fails on missing release credentials it never needed.
    const passwordResolution = `
    // Release keystore passwords — resolved at Gradle configuration time, never baked
    // in as literals. Sources, in order: TURBO_STORE_PASSWORD / TURBO_KEY_PASSWORD
    // env vars, then the gitignored mobile/keystore.properties (keys storePassword /
    // keyPassword). Throws a descriptive error when neither source provides them so a
    // release build fails loudly instead of silently producing an unsigned build or
    // one signed with the debug key.
    def turboStorePassword = System.getenv('TURBO_STORE_PASSWORD')
    def turboKeyPassword = System.getenv('TURBO_KEY_PASSWORD')
    def keystorePropsFile = file('../../keystore.properties')
    if (keystorePropsFile.exists()) {
        def keystoreProps = new Properties()
        keystorePropsFile.withInputStream { keystoreProps.load(it) }
        if (turboStorePassword == null) turboStorePassword = keystoreProps.getProperty('storePassword')
        if (turboKeyPassword == null) turboKeyPassword = keystoreProps.getProperty('keyPassword')
    }
    def buildingRelease = gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }
    if (buildingRelease && (turboStorePassword == null || turboKeyPassword == null)) {
        throw new GradleException(
            'Release signing passwords missing: set the TURBO_STORE_PASSWORD and TURBO_KEY_PASSWORD environment variables, or create mobile/keystore.properties with storePassword and keyPassword (both gitignored).'
        )
    }
    if (turboStorePassword == null) turboStorePassword = ''
    if (turboKeyPassword == null) turboKeyPassword = ''
`;

    const releaseSigningConfig = `
        release {
            storeFile file('${absoluteKeystorePath}')
            storePassword turboStorePassword
            keyAlias '${keyAlias}'
            keyPassword turboKeyPassword
        }
    }`;

    // Inject the password resolution just before the signingConfigs block opens.
    config.modResults.contents = config.modResults.contents.replace(
      /(\n\s*)(signingConfigs\s*\{)/,
      `$1${passwordResolution.trimEnd()}$1$2`
    );
    // The generated file's signingConfigs block ends right after the debug config's
    // closing brace + the block's own closing brace — matches that exact shape from
    // Expo's own android-app-build-gradle template rather than a broad regex.
    config.modResults.contents = config.modResults.contents.replace(
      /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\}\n)(\s*\})/,
      `$1${releaseSigningConfig}`
    );
    // Anchored on the "Caution!" comment Expo's template always emits right above
    // the release buildType's own signingConfig line — the naive "release {" anchor
    // also matches signingConfigs.release above it, and there's a second, unrelated
    // "signingConfig signingConfigs.debug" line in buildTypes.debug that must stay
    // untouched.
    config.modResults.contents = config.modResults.contents.replace(
      /(In production, you need to generate your own keystore file[\s\S]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.release'
    );

    return config;
  });
};
