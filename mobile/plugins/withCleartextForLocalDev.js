const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Android 9+ blocks cleartext (plain HTTP) by default. That is right for the shipped
// app — the real server address is always HTTPS — but it also blocks the "Custom server
// address" dev toggle, which by design points at a self-hosted backend over HTTP.
//
// Two configs, because the two cases want opposite answers and Android resolves this
// resource per build variant (src/debug/res wins over src/main/res in a debug build):
//
// - Release keeps a single narrow exception for the Android emulator's host-loopback
//   alias, which CI's Maestro flow uses against a seeded backend. Nothing else.
// - Debug permits cleartext outright. A dev backend lives on whatever LAN address the
//   developer's machine happens to have that day (192.168.x.x, 10.x.x.x, a tethered
//   172.20.x.x), and network-security-config matches literal hosts with no CIDR or
//   wildcard support, so enumerating them is not possible. A debug build is already
//   debuggable and developer-installed, so this grants nothing a debug build lacks.
const RELEASE_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.0.2.2</domain>
    </domain-config>
</network-security-config>
`;

const DEBUG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Debug variant only: a dev backend's LAN address cannot be predicted, and
         network-security-config has no wildcard or CIDR matching. -->
    <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

function write(root, variant, contents) {
  const xmlDir = path.join(root, `app/src/${variant}/res/xml`);
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), contents);
}

module.exports = function withCleartextForLocalDev(config) {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const root = config.modRequest.platformProjectRoot;
      write(root, 'main', RELEASE_XML);
      write(root, 'debug', DEBUG_XML);
      return config;
    },
  ]);

  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application[0];
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return config;
  });
};
