#!/usr/bin/env node
// Bumps mobile/app.json's expo.version (the source of truth for the shipped app
// version) and mirrors it into mobile/package.json, same semver logic release.yml's
// bump-version job uses on CI. Also bumps android.versionCode by 1 — this build
// path (release-full.ps1 -> release-local.sh -> gradlew) builds locally and never
// goes through EAS, so nothing else increments it (EAS's remote appVersionSource
// counter, which release.yml's CI builds rely on, only advances on EAS's own
// servers). Without this, every local release APK would ship the same
// versionCode and Android would refuse to treat it as an update.
// Prints the resulting version on success.
//
// Usage: node bump-version.js <patch|minor|major>
const fs = require("fs");
const path = require("path");

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("Usage: node bump-version.js <patch|minor|major>");
  process.exit(1);
}

const appJsonPath = path.join(__dirname, "..", "app.json");
const pkgJsonPath = path.join(__dirname, "..", "package.json");

const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf8"));
const [major, minor, patch] = appJson.expo.version.split(".").map(Number);
const next =
  bump === "major" ? [major + 1, 0, 0] :
  bump === "minor" ? [major, minor + 1, 0] :
  [major, minor, patch + 1];
const version = next.join(".");

appJson.expo.version = version;
appJson.expo.android.versionCode = (appJson.expo.android.versionCode || 0) + 1;
fs.writeFileSync(appJsonPath, JSON.stringify(appJson, null, 2) + "\n");

const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
pkg.version = version;
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(version);
