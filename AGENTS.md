# Notes for coding agents

This file is for AI coding tools working in this repo. People should start with
[`README.md`](README.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Orientation

- The app is in `mobile/`: Expo SDK 57, React Native, Expo Router, TypeScript.
  Check the installed versions and the current Expo docs before relying on memory.
- Routes are in `mobile/src/app/`, feature code in `mobile/src/features/<feature>/`,
  shared code in `mobile/src/lib/` and `mobile/src/components/`. Native Kotlin modules
  are in `mobile/modules/`.
- Terms are defined in [`docs/context.md`](docs/context.md). Design decisions are in
  [`docs/adr/`](docs/adr/).

## Rules that protect ride recording

- The phone provides GPS only. Board telemetry (speed, battery, mode) comes from the
  board over Bluetooth. Only board wheel speed starts or ends a ride.
- One `BoardBleClient` per board. Stop and remove the old client before creating a new one.
- Keep all three reconnection layers (WorkManager, `expo-background-task`, the wake
  scan). They cover different failure cases.
- Saved trips take their route from the native ride journal in `modules/ride-core/`.
- Anything that runs at launch or in a service must fail soft: check permissions
  without prompting, and catch errors from platform calls.

## Checks

- `cd mobile && npm run verify` runs typecheck, lint and tests. It must pass.
- Don't add lint warnings. `lint:strict` allows none.
- Use `npm run lint`, not `npx expo lint`, which caches and skips files.
- Bluetooth and background changes need a test on a real device.

## Style

- Comments explain something non-obvious in a sentence or two. No dates, issue
  numbers or incident stories.
- UI copy is plain: no hedging, no em dashes joining clauses.
- A `TextInput` in a modal wires its return key to the modal's main action.
  Don't open a second modal on top of one.

## Don't

- Commit secrets (`.env`, `credentials.json`, keystores).
- Add AI attribution (`Co-Authored-By` trailers, "generated with" footers) to
  commits, PRs or files.
- Run cloud EAS builds. Release builds are local.
