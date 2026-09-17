<!-- PR title format: `<type> - <Title>`, e.g. `bug - Keep the session when offline`.
This repo squash-merges, so the PR title becomes the commit title on `main`.
Types: feature / bug / urgent / chore / docs. See CONTRIBUTING.md. -->

## What this does

<!-- One or two sentences. -->

## Why

<!-- The problem it solves. Link the issue if there is one. -->

## Testing

<!-- What did you actually run or check? "Ran npm run verify, all green." "Tested
pairing on a real phone, telemetry updated." "Should work" isn't testing. -->

## Checklist

- [ ] No secrets, `.env` files, keystores or credentials in this diff
- [ ] `mobile/`: `npm run verify` passes (typecheck, lint, formatting, tests)
- [ ] Native or Bluetooth changes tested on a real device, not just a clean build
- [ ] `npm run test:native` run if `mobile/modules/` changed
- [ ] `README.md`/`docs/` updated if this changes behaviour or how to run something
