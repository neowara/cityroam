# Local E2E — the actual pre-release gate

These Maestro flows are the pre-release gate for a release — run them by hand,
against a real local build, right before `npm run release:full`
(see [`../README.md`](../README.md#building--releasing-an-apk)).

## Run before every release

```sh
# From mobile/, with an emulator already running (or one boots on demand):
npx expo run:android          # real local build, not a debug stand-in for what ships
bash .maestro/run-both-themes.sh
```

`run-both-themes.sh` runs the given flows (default: `explore.yaml trip-fab-toggle.yaml`)
once in light mode, once in dark, and leaves the device in light mode afterward. Pass
flows explicitly to run a different set:

```sh
bash .maestro/run-both-themes.sh ".maestro/explore.yaml .maestro/trip-fab-toggle.yaml .maestro/trip-data-visible.yaml"
```

`trip-data-visible.yaml` needs a seeded backend reachable at `10.0.2.2:8420` (the
emulator's alias for the host loopback interface) first:

```sh
# From backend/, in a separate terminal:
DATABASE_URL=sqlite:///./seed-local.db python -m scripts.seed --count 15 --reset --seed 1337
DATABASE_URL=sqlite:///./seed-local.db python -m uvicorn app.main:app --host 0.0.0.0 --port 8420
```

Then in the app's Settings, enable "Custom server address" and point it at
`http://10.0.2.2:8420`.

## What stays in GitHub Actions

`mobile-ci.yml`/`backend-ci.yml` still run automatically on every push — typecheck,
unit tests, bundle sanity, pytest, migration-apply check. Cheap, fast, reliable
checks stay automatic; the expensive, flaky, judgment-heavy one (does the UI actually
work, on a real emulator, in both themes) is a deliberate manual step right before a
release — which is also the point in the cycle it's actually needed.
