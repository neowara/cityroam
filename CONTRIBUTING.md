# Contributing

Cityroam is source-available under the [PolyForm Strict License](LICENSE), not open
source. Issues and bug reports are welcome. Pull requests come from invited
collaborators only, so open an issue and ask before starting work.

By opening a pull request you confirm that you wrote the change or otherwise have the
right to submit it, and that it can be distributed under the project's licence.

## Setup

See [`mobile/README.md`](mobile/README.md). You need Node LTS, Android Studio with an SDK,
and an emulator or a phone.

Two things are deliberately not in this repository:

- **The backend.** The app's default server is run by the maintainer and accounts are
  invite-only. For development, run your own copy and point
  `EXPO_PUBLIC_DEFAULT_SERVER_ADDRESS` at it.
- **A release keystore.** Release builds are signed locally. If you build your own, change
  the Android `applicationId` in `mobile/app.json` and use your own keystore.

## Making a change

1. Branch from `main` with a prefix that matches the change: `feature/`, `bug/`,
   `urgent/`, `chore/`, `docs/`.
2. Keep the change focused. Refactors and formatting go in their own PR.
3. Run `npm run verify` in `mobile/`. It must pass, and it must not add lint warnings.
4. If you touched Bluetooth, background work or anything under `mobile/modules/`, test on
   a real phone and say so in the PR. `npm run test:native` runs the Kotlin unit tests for
   the native modules; it isn't part of CI, so run it yourself.
5. Title the PR `<type> - <Title>`, for example `bug - Keep the session when offline`.
   PRs are squash-merged, so the PR title becomes the commit title on `main`.

## Style

- TypeScript is formatted with Prettier (`npm run format`); `verify` checks it.
- Comments explain why, briefly. No dates, issue numbers or incident stories in code.
- UI copy is short and direct. No hedging, and no em dashes holding two clauses together.
- No `Co-Authored-By` trailers or "generated with" footers from AI tools.

## Conduct

See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Security

Don't open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).
