# Cityroam glossary

The domain of the Cityroam Android app: recording rides from a Bluetooth-connected Tynee board, estimating the remaining riding range, and persisting completed trips for the trips list.

## Language

**Trip**:
A single recorded ride from the moment recording starts to when it ends, ultimately persisted to the backend and shown in the trips list.
_Avoid_: ride

**Trip finalization**:
The end-of-ride step that turns accumulated trip state — and, when available, an end telemetry snapshot — into a persisted Trip. It is shared by both the live-finish path (user ends the ride, auto-end, or manual-start handoff) and the crash-recovery path, and produces one of three outcomes: saved, discarded (too short / too far), or failed.

**Trip checkpoint**:
The periodically-persisted snapshot of an in-progress Trip that survives an app crash, so an interrupted ride can be finalized later.

**Trip recovery**:
At next launch after an interrupted session, finalizing a saved Trip checkpoint as its own completed Trip rather than attempting a seamless resume.
_Avoid_: seamless resume

**Offline trip**:
A finalized Trip that has been durably written to the phone's local queue but hasn't reached the backend yet. Shown everywhere a Trip normally is — the trips list, activity charts, the dashboard's last-ride card, the widget — merged with synced trips by date, not a separate pending view. Its `id` is the negation of its local queue row id, so it's never mistaken for a real backend trip id. Weather and Health Connect vitals are already correct on an offline trip (captured on the phone at ride-finish time); the elevation profile and cost-by-mode comparison are backend-only and stay locked until it syncs.
_Avoid_: pending trip, unsaved trip (it *is* saved — just not synced)

**Synced trip**:
A Trip that has reached the backend and has a real (positive) trip id. Elevation and cost-by-mode become available once a trip reaches this state.

**Trip sync**:
The retry that uploads a queued Offline trip to the backend — automatic (on trip finish, app cold start, and every foreground return) or triggered manually (the trip detail screen's "Upload trip to server," or Settings' "Sync now"). Distinct from Trip recovery (Settings' "Check for an interrupted trip" forces that instead) — recovery turns a Trip checkpoint into a real Offline trip; sync is what happens to it after. Never blocks the trip from existing locally in the meantime.

**Board**:
The hardware itself, the source of live telemetry — battery level, odometer, riding mode, voltage — delivered over BLE. "Board" is this glossary's and the codebase's neutral term for it.

In the UI it is named after whatever the rider actually rides: a Tynee is a **board**, a NAVEE is a **scooter**. Exactly one product family is selectable at a time, so the noun is never ambiguous. User-facing strings get it from `useDeviceNoun()` (`mobile/src/features/device/deviceNoun.ts`) rather than hardcoding either word.
_Avoid_: "device" in user-facing copy — it reads like a manual. Identifiers and internal docs still use board/device freely.

**Mode**:
The board's riding mode — its identity, ordering, labels, and colors as presented in the UI.

**Range estimate**:
The predicted remaining riding distance, computed by scaling the board's per-mode efficiency (km per % battery) by the current battery level, with a confidence band (low/high) when the charge estimate comes from voltage rather than a direct battery reading. Shown on the dashboard, and used by the Plan tab to judge whether a destination is reachable in each mode — sharpened by the rider's weight and the board's battery capacity when those are available.

**Ride journal**:
The native, on-device SQLite record of a ride (`mobile/modules/ride-core/`'s `RideJournal`), written directly from the BLE/GPS layers independent of the JS runtime's own lifecycle. A durability backstop underneath Trip — it survives the JS runtime being paused or killed — and, since its GPS request outlives the Activity lifecycle the JS watch is tied to, the source of a saved trip's route array, in place of the JS-collected one. Reconciled into a Trip via Trip finalization like any other source, never shown to the rider directly. See ADR 0006.
_Avoid_: ride log (unrelated to the on-device debug log), native trip

**Self-heal layer**:
Any of the three independent mechanisms that bring the board connection back without the rider reopening the app: the native `WorkManager` job, `expo-background-task`, and the wake scan below. Named as a set because none of the three is reliable alone — each covers a case (process alive, process backgrounded, process killed) the others can't.

**Wake scan**:
The `PendingIntent`-based BLE scan (`BoardWakeScan`/`BoardWakeScanReceiver`) that the system, not the app process, holds — so it can restart board reconnection even after the process has been killed outright, per `BluetoothLeScanner`'s own documented purpose for that API shape.

**Stitch window**:
The runtime-configurable grace period (default 60s) after a ride ends for reason `board_off` during which a reconnect that shows continuous board trip counters (dp5/dp6) re-opens the same ride instead of starting a new one — a genuine link blip, not the rider actually stopping.

**Home geofence**:
A rider-set location (`mobile/src/features/rides/homeGeofence.ts`) whose EXIT transition wakes the app — including from a killed process — to prime reconnection before the rider reaches the board. Never starts or ends a Trip itself; only the board's own wheel speed does that, so a false trigger is harmless by design.
