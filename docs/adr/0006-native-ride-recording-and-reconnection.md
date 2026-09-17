# 0006 — Native ride journal, address-type-aware reconnection, and a third self-heal layer

## Status

Accepted, with real, disclosed parts still unverified on-device (marked below).

## Context

A review of the BLE session lifecycle and background-recording path found the actual
root cause of a recorded regression (several `BoardBleClient` instances handshaking
against the same board at once, because stopping a client didn't stop its in-flight
connect cycle) and a structural gap: trip recording lived entirely in the JS runtime,
which Android pauses or kills independent of the BLE link staying up. Fixing the
concurrency bug was a small, contained change (`BoardBleClient.stop()` now actually
stops, and callers adopt an existing client instead of replacing it). Closing the
structural gap needed new capability, covered here.

## Decisions

**A native ride journal (`modules/ride-core/`).** `RideService` runs as a foreground
service (`connectedDevice|location` types, computed at runtime from granted
permissions), owns a `FusedLocationProviderClient` request that isn't tied to the
Activity lifecycle (the JS `watchPositionAsync` path is — confirmed against
`expo-location`'s own Android source, it drops every request the moment the app
backgrounds), and writes every GPS fix and board datapoint to a local SQLite journal
(`RideJournal`) as they arrive. `RideMachine` is a from-scratch port of
`tripStateMachine.ts` with one real rule change: the board disconnecting ends the ride
**instantly**, no grace period — a rider's explicit choice. A brief link blip (not a
genuine power-off) is handled by re-opening the just-finished ride if the board's own
trip counters (dp5 `mileage_once`, dp6 `ridetime_once`) prove they never reset,
within a runtime-configurable stitch window (default 60s, 0 disables it).

`BoardBleClient` fans dp/connection events out to this native layer via a
process-wide `RideObserver`, independent of whichever JS `Listener` currently has
adopted the client — so capture happens whether or not a JS runtime is alive to
receive anything.

**The native journal is now the route source; `tripRecorder.ts` still owns
everything else.** Both capture paths still run — `tripRecorder.ts` keeps driving
auto-start/stop, board telemetry (battery/odometer/mode/voltage/speed), and the live
UI exactly as before, and `lib/rideCoreSync.ts` still independently finalizes and
uploads any native ride the JS side never even saw (app killed before its own
finalize ran), reusing `tripFinalize.ts`'s discard guard and the existing
offline-first save queue (see ADR 0001 — a ride is durable locally the instant it's
queued, and uploads whenever the backend is reachable). What changed: at the moment
a JS-tracked trip finalizes (live finish or crash recovery), `getNativeRouteForTrip`
looks up the native journal's matching ride — matched by start-time proximity, since
the two state machines start independently and share no id — and its GPS samples
become the saved trip's `route`, in place of the JS `watchPositionAsync` one.

This followed a real on-device comparison, not a guess: one production ride, same
board, same trip, diffed both paths' saved data directly from the backend database.
The native path won on every measured axis — 1448 GPS points vs. 440, a 2s max gap
vs. two 45s gaps and a 31s gap, distance matching the board's own odometer exactly,
a successful OSRM map-match where the JS path's was discarded for being too sparse,
a successful Health Connect write where the JS path's failed on out-of-order
timestamps from the same sparse route. `RideLocationManager` owns a
`FusedLocationProviderClient` request on a dedicated thread, independent of the
Activity lifecycle the JS watch is tied to — that's the entire reason for the gap,
not a tuning difference that could be closed by adjusting the JS watch instead.

`getNativeRouteForTrip` falls back to the JS-collected route whenever no native ride
matches closely enough (no ride-core prebuilt in this build, or a genuine timing
miss) — a trip is never saved with no route at all. Deliberately **read-only**: it
never marks the matched ride uploaded. `RideMachine`'s own reconnect-stitch logic
(`findStitchCandidateLocked`) only reopens a ride still in the `'finished'` state, and
both state machines end a ride on the same disconnect instant with no grace period —
marking a ride `'uploaded'` the moment the live path reads its route would make a
same-second BLE reconnect, well within the stitch window, silently open a new native
ride instead of continuing this one. B1-c's `clientTripId` idempotency key is what
keeps `rideCoreSync.ts`'s own finished-ride sync from creating a duplicate Trip if it
later processes the same ride the live path already saved: the backend recognizes the
repeat submission and returns the existing trip. The app-level `finalizeInFlight`
guard (already used by `recoverInterruptedTrip`) also now gates that sync pass, so it
never runs concurrently with a live finish still saving the same ride.

Removing the JS GPS watch's own capture entirely (`watchPositionAsync`,
`tripRecord.ts`'s `route.push`) is real, deliberately-scoped-out follow-up work, not
an oversight — it still runs today, both as the fallback route source above and
because it also drives the JS-side "stops" detection, which the native journal
doesn't yet track. Removing it is what finally lets the third (expo-location)
persistent notification go away too (see §8.3 of the originating plan). Not blocked
on anything further; a matter of scheduling, not risk.

**Address-type-aware reconnection.** `BluetoothDevice.getAddressType()` (API 35) and
`BluetoothAdapter.getRemoteLeDevice(address, type)` (API 33) are the documented,
type-aware way to reconnect to a device whose address isn't public — the legacy
`getRemoteDevice(address)` silently assumes a public address, which the earlier
one-off hardware test for the parked-autoConnect path may simply have been unable to
work around. Below API 33, and for any board whose type was never learned, the client
falls back to the legacy call, which is the only option there is on those levels.
`BoardScanner.addressTypeOf` reads the real type where the API exists and otherwise
infers it from the top two bits of the MAC (a Bluetooth Core Spec property, not a
documented Android API — a heuristic, not authoritative). Stored alongside the MAC
in `BoardCredentialStore` and `boardCredentials.ts`.

**A third self-heal layer: a `PendingIntent`-based BLE scan (`BoardWakeScan`).**
The other two self-heal layers (native `WorkManager`, JS `expo-background-task`, see
ADR 0005) both need the app's process to already exist to run at all. A scan
registered via `BluetoothLeScanner.startScan(filters, settings, PendingIntent)` is
held by the system, not the app process, and — per `BluetoothLeScanner`'s own
reference documentation, quoted directly rather than assumed — is explicitly meant for
exactly this: *"Use this method of scanning if your process is not always running and
it should be started when scan results are available."* Delivery is an explicit
broadcast to a manifest-declared, unexported receiver (`BoardWakeScanReceiver`),
which is exempt from the Android 8+ implicit-broadcast manifest-receiver restriction
because it targets a specific component, not an implicit action. Filtered by the
board's FD50 service UUID only, never by MAC — the public `ScanFilter` API assumes a
public address type when filtering by address, and the framework classifies a
non-public address type in an address filter as a `BLUETOOTH_PRIVILEGED` operation,
unavailable to a normal app.

Armed alongside the other two self-heal layers (`startBackgroundReconnect`), not
around every individual connect/disconnect — the board stops advertising once
genuinely connected, so an idle armed scan matches nothing and costs nothing extra.

**A home-area geofence (`lib/homeGeofence.ts`), at the JS level.** Built on
`expo-location`'s own `startGeofencingAsync`/`TaskManager` API rather than hand-rolled
native `GeofencingClient` code — same functional outcome (an EXIT transition wakes the
app, including from a killed process, and is itself a documented background-service-
start exemption), far less native surface to get wrong blind. Primes native ride
capture and takes a fresh location fix on exit; **never** starts or ends a ride
itself — a wrong "left home" guess is harmless by design. Home is set by the rider
(Settings, or the debug Diagnostics panel) rather than derived from ride history;
auto-derivation is real, deliberately-scoped-out follow-up work.

**A Diagnostics panel in the existing debug console**, not a new screen — same
developer-only audience. Surfaces the runtime switches (idle-connect strategy, stitch
window, native capture on/off) and live state (BLE phase) so a failed on-device check
means flipping a switch, not a redesign.

## Consequences

- **Unverified on a real device as of this decision**, the same honest caveat ADR
  0005 already carries for its own two layers: whether `getAddressType()` genuinely
  changes reconnect behaviour on this board, whether the `PendingIntent` scan survives
  a real process kill in practice (vs. only being documented to), and whether the
  stitch window's dp5/dp6 continuity check actually holds across a real link blip, are
  all open until run on-device. Every one of them is behind a runtime switch or a
  fallback specifically so a failed check means flipping a default, not a redesign.
- **Battery cost**: one always-registered low-power BLE scan, one always-registered
  home geofence (Android's own geofencing implementation, built on Fused Location, is
  documented as optimized for this), and — only while a ride is actually recording — a
  high-accuracy location request and a partial wake lock, released the moment the ride
  ends. No continuous GPS while idle; unchanged from the existing PHONE = GPS only /
  DEVICE = telemetry invariant.
- **Two capture paths still running in parallel** (JS and native) is deliberate,
  ongoing duplication, not an oversight — the JS path now defers to the native one
  for the route array specifically (see the decision above), but still independently
  captures its own route as a fallback and still owns everything else. Fully retiring
  the JS GPS watch is scoped, tracked follow-up work, not blocked on anything further.
- Reinforces ADR 0004's rule: `RideService` is started once and never stopped in
  response to board connection or ride state. It absorbed the connection-keeping
  foreground service that used to be `BoardConnectionService` (board-ble module) —
  the two were always one concern split across two services and two notifications —
  bridged across the module boundary via `BoardBleClient.ForegroundOwner`, a
  manifest-registered `ContentProvider` in ride-core, since `board-ble` cannot import
  `ride-core` directly (the dependency runs the other way).
