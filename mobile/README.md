# Cityroam mobile app

Expo Router app for Android. For what the app does, see [`docs/index.md`](../docs/index.md).

## Setup

```bash
npm install
cp .env.example .env
npm run android
```

`.env` holds one value, `EXPO_PUBLIC_DEFAULT_SERVER_ADDRESS`, the server the app talks to.
It is compiled into the JavaScript bundle, so don't put anything secret there. Settings
has a custom server address option to switch servers at runtime.

Expo Go can't run this app because it uses MapLibre, Health Connect, background location
and local native modules. Build once with `npm run android`; after that `npx expo start`
is enough for JavaScript-only changes.

`npm run android` boots an existing emulator first if no device is connected. It looks
for an AVD named `tynee_test`; set `TURBO_AVD_NAME` to use another one.

Board pairing needs no build-time keys. The rider signs in with their vendor account once
inside the app; the board key it returns is stored in `expo-secure-store` and everything
after that is direct Bluetooth.

## Checks

```bash
npm run verify        # typecheck, lint (warning count capped), Jest
npm run lint:fix      # apply automatic lint fixes
npm run format        # Prettier
npm run test:native   # Kotlin unit tests for board-ble and ride-core (needs a prebuilt android/)
npx expo-doctor       # dependency and config sanity
```

CI runs `npm run verify` and an Android bundle export on every push and PR. The Kotlin
tests are not in CI because they need a full Gradle build; run them after changing
`modules/board-ble/` or `modules/ride-core/`. Mistakes there tend to produce plausible
wrong output rather than an error.

End-to-end flows for Maestro are in [`.maestro/`](.maestro/).

## Layout

```
src/
  app/            Routes. (tabs)/ holds Dashboard, Rides, Activity, Plan and Settings.
  features/
    auth/         Session, login, offline session cache
    device/       Board pairing, Bluetooth link, board settings
    health/       Health Connect
    planner/      Trip planner and range estimate
    rides/        Trip recorder, finalize, sync, native journal reconciliation
    settings/     Settings screen pieces
    updates/      In-app update check
    widget/       Home screen widget
  components/     Shared UI
  lib/            API client, local database, queries, theme, logging
modules/
  board-ble/      Bluetooth protocol client for Tynee boards (Kotlin)
  navee-ble/      Bluetooth client for NAVEE scooters (Kotlin)
  ride-core/      Ride foreground service, native journal, ride state machine (Kotlin)
  cityroam-widget/, app-updater/, device-power/
plugins/          Expo config plugins
```

Path aliases: `@/` is `src/`, `@modules/` is `modules/`, `@assets/` is `assets/`.

## Building a release APK

Releases are built locally with EAS's `--local` mode. Never queue a cloud build.

```bash
npm run release:local           # signed APK, no version bump
npm run release:local:install   # same, then adb install
npm run release:full            # verify, build, bump version, tag and publish a GitHub release
```

Signing needs `credentials.json` (from `eas credentials -p android`) and the keystore
passwords, either as `TURBO_STORE_PASSWORD` and `TURBO_KEY_PASSWORD` or in a
`keystore.properties` file. Both files are gitignored. Without them the build is
debug-signed, and it can't be installed over a release-signed copy of the app.
