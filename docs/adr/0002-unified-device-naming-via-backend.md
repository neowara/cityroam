# 0002 — One device name per device, backed by the server

## Status

Accepted. "Tuya SDK string" below now means the product name the board reports over
the direct BLE client — the fallback's position in the chain is unchanged.

## Context

Two independent, disconnected "board name" concepts existed:

1. **board-config.tsx's "Board name" row** — wrote a phone-local-only AsyncStorage
   value (`PairedDevice.name`), read by `resolveDeviceName`/`getBleSnapshot` to feed
   the Dashboard's live board-name display.
2. **EstimateSettingsCard's "Friendly device name" field** (Settings) — already wrote
   the backend's `DeviceSetting.deviceName`, used for range-estimate/calibration
   display.

Renaming in one place had no effect on the other. Worse, the local-only name had a
real bug: `activateBleDevice` (the pairing/re-pairing path) unconditionally
overwrote `PairedDevice.name` with the raw Tuya SDK/product string (e.g. `"HW70009
ZYD056 3"`) on every activation — including *re*-activating an already-paired
device, which is the normal path whenever BLE bonding resets, not just a genuine
first pair. A custom name was silently wiped back to the factory string every time
the board had to be re-paired. Given how often BLE bonding issues came up in
practice, this made renaming look like it simply "never saved."

## Decision

`DeviceSetting.deviceName` (the field EstimateSettingsCard already used) is the one
source of truth. Both name-editing surfaces write the same value:

- `renamePairedDevice` now updates the local AsyncStorage cache immediately
  (instant, offline-safe UI feedback — the typed name is never lost even if the
  network call below fails), then writes through to the backend via
  `PUT /devices/{id}/settings`. That endpoint is a full replace, not a merge patch,
  so the write fetches the device's current settings first and sends them back
  unchanged alongside the new name — otherwise weight/battery-capacity/spec-sheet
  values saved via EstimateSettingsCard would revert to null.
- `resolveDeviceName` (called by `getBleSnapshot`, polled every 2s while the
  Dashboard is open) checks, in order: local cache → backend
  (`GET /devices/{id}/settings`) → the raw Tuya SDK string — and backfills the local
  cache with whatever it finds, so this only ever costs one backend round trip, not
  one per poll.
- `activateBleDevice`'s existing-name preservation (the direct fix for the wipe-on-
  re-pair bug) checks the backend too, not just the local cache — so a board paired
  fresh on a *different* phone, or re-paired after this phone's local cache was
  somehow cleared, still recovers its name instead of resetting.
- `BoardNameRow` hydrates via `resolveDeviceName`, not the local-only cache, so the
  rename screen shows the real current name (backend or local) instead of blank
  when the local cache is empty.
- An empty rename clears the name both locally and on the backend — the "cleared"
  state persists too, not just new non-empty values.

## Consequences

- A device's name now survives a reinstall, a re-pair, or being paired on a second
  phone under the same account — the backend is the durable copy.
- The backend write is best-effort (never blocks the rename from applying locally);
  a failed write is simply retried by renaming again. No queue/retry mechanism was
  added for this specifically — renaming is a low-frequency, user-initiated action,
  not worth the complexity a durable retry queue would add.
- `PUT /devices/{id}/settings`'s full-replace contract means every caller that
  writes a *partial* update (this one, name-only) must always read-then-write the
  full object — a footgun worth remembering if a third editor of this endpoint ever
  gets added.
