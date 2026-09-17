# 0005 — Periodic self-heal after the app process is killed outright

## Status

Accepted. The decision still holds, but the names below are historical: the SDK it
was written against has been replaced by the in-house BLE client, so
`modules/tuya-ble` is now `modules/board-ble`, `TuyaBleForegroundService` is
`BoardConnectionService`, and `BleSelfHealWorker` is `BoardSelfHealWorker`. The
two-layer design itself is unchanged.

Originally accepted with known-unverified layers flagged explicitly below. **Do not treat
either layer of this as proven working until confirmed on a real device** (kill the
app for real, wait past the 15-minute interval, check `adb logcat` for both the
native worker and the JS task actually firing) — see Consequences.

## Context

ADR 0004 closed the case where the location foreground service failed to *start*
from the background. It does not cover a different, harder case: Android (or an OEM
battery killer) can kill the app process outright while backgrounded. When that
happens, everything JS-side (trip recording, GPS watch, checkpointing) and the
in-memory state of the native `TuyaBleForegroundService` (`activeDevId`,
`running`) is gone. `START_STICKY` brings the bare service back, but with no devId
to reconnect to and no JS runtime — nothing self-heals; tracking silently stays off
until the user manually reopens the app.

The user's explicit goal: grab the board, ride, and the app just handles it — no
reopening required, ever, even across days of intermittent background riding. A
periodic wake, independent of the process staying alive, is the only way to close
this gap. Two independent layers were built, not one, because research surfaced a
real risk with the obvious single-layer approach:

- `expo-task-manager`'s headless `TaskManager.defineTask` bridge on Android has a
  **documented history of unreliable headless callback delivery** — this exact
  codebase already found one live instance of it (see the comment on
  `LOCATION_TASK_NAME` in `mobile/lib/tripRecorder/location.ts`, tracking
  expo/expo#28959: the task fires on schedule but its data callback never receives
  anything). Web research surfaced the same underlying failure mode recurring across
  multiple other `expo-task-manager` consumers (background-fetch, background
  notifications) across several SDK versions and years, not a one-off bug already
  fixed for good.
- `expo-background-task` (the official, WorkManager-backed replacement for the
  deprecated `expo-background-fetch`) still ultimately depends on that same
  `TaskManager.defineTask` bridge to wake the JS layer. Building only on this layer
  risks the exact false-confidence failure mode this app has already been burned by
  once this session: something that appears wired up correctly but silently doesn't
  fire in production.

## Decision

Two independent self-heal layers, not one:

1. **Native, JS-independent (`BleSelfHealWorker.kt`, in `modules/tuya-ble/android`)**
   — a plain `androidx.work.Worker`, scheduled via `WorkManager`
   (`PeriodicWorkRequestBuilder`, 15-minute interval — WorkManager's own OS-enforced
   minimum, not a choice made here). Reads the last-known paired `devId` from native
   `SharedPreferences` (persisted specifically so a freshly-recreated process, with no
   JS ever having run, still knows what to do) and re-issues
   `TuyaBleForegroundService.start`. This never touches the JS/React Native runtime
   at all, so it is not exposed to the bridge risk above. It only handles the
   BLE/board-connection side, not GPS or trip recording (both of which live in JS).
   **Not a hard guarantee either, on its own** — see Consequences: starting a
   foreground service from inside `doWork()` with no visible app UI can still hit
   the same Android 12+ `ForegroundServiceStartNotAllowedException` restriction ADR
   0004 fixed on the JS side. Caught and logged (`BleSelfHealWorker` doesn't crash),
   not worked around — the honest position is "meaningfully more robust than the JS
   layer, not proven bulletproof."
2. **JS, via `expo-background-task`** (`mobile/lib/backgroundSelfHeal.ts`) — a
   `TaskManager.defineTask`'d task that calls `ensureForegroundServiceRunning()`
   (ADR 0004's persistent GPS service) on the same ~15-minute cadence. This is a
   genuine attempt at reviving the GPS/trip-recording side specifically, but is
   **not** assumed reliable — see Consequences.

Both are scheduled from `mobile/lib/backgroundSelfHeal.ts`'s
`applyBackgroundSelfHeal()`, called whenever a board is registered
(`lib/boardLink/session.ts`'s `ensureRegistered`) and torn down on a genuine forget
(`lib/boardLink.ts`'s `forgetPairedDevice`). Gated on a new Settings toggle ("Keep
recording if Android kills the app", Ride Tracking tab) — **defaults on**, per an
explicit user decision to accept the battery tradeoff by default rather than have it
off until manually found and enabled.

## Consequences

- **Real-world recovery time is not instant.** WorkManager's periodic-work
  guarantee is "at least every ~15 minutes, subject to OS batching/Doze deferral" —
  worst case, a killed process can sit dead for meaningfully longer than 15 minutes
  before the native layer's next tick fires.
- **A user-initiated force-stop (swiping the app away, or explicitly "Force stop" in
  Android's app info screen) defeats this entirely, and no app-level code can work
  around it.** Android's `FLAG_STOPPED` app state blocks WorkManager (and all other
  background execution) until the user manually reopens the app — this is a
  deliberate OS policy, not a bug. This app cannot and does not attempt to prevent
  it; it only recovers from the OS or an OEM battery-killer ending the process, not
  from the user ending it themselves.
- **Both layers are unverified on a real device as of this decision**, for two
  distinct reasons — not assumed proven from a clean `tsc`/`jest` pass:
  - The JS/GPS layer (`expo-background-task`) depends on `expo-task-manager`'s
    headless bridge, with the documented Android reliability history above.
  - The native layer's `TuyaBleForegroundService.start()` call inside
    `BleSelfHealWorker.doWork()` can itself hit Android 12+'s
    `ForegroundServiceStartNotAllowedException` when the process has no visible UI
    — exactly the state a freshly-recreated-after-kill process is in. The worker
    catches and logs this rather than crashing, but does not work around it.
  - If both fail in the exact same tick, the honest fallback is "nothing recovers
    until the user reopens the app" — the same as before this ADR. The realistic
    expectation is that this is rarer post-fix than before (not every kill lands in
    the exact restricted state, and the JS layer's known-flaky bridge still works
    some of the time), not that the gap is fully closed. Confirm on a real device
    (kill the app, wait past 15min, check `adb logcat` for both
    `BleSelfHealWorker` and the JS task) before treating this as settled.
- Battery cost: one WorkManager wake + a mostly-idle service re-assertion roughly
  every 15+ minutes while a board is paired and this setting is on — small, but real
  and continuous, which is why it's an explicit, defaulted-on Settings toggle rather
  than unconditional.
