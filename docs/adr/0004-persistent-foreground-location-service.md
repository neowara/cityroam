# 0004 — The location foreground service stays running once started; don't tear it down on disconnect

## Status

Accepted. **Do not revert this without reading the whole document below** — the
previous behavior (start/stop the service on every board connect/disconnect) was
tried, shipped, and caused confirmed production data loss. If a future change
reintroduces stop/start cycling of the foreground service tied to board connection
state, it will reintroduce this bug.

## Context

Confirmed directly against production logs (pulled from the real backend DB via
SSH), not a guess: a real ride — board connected, `auto_start` fired, genuine
movement — went **completely silent for 6 minutes 57 seconds**. No GPS samples, no
BLE responses, nothing. The very first GPS sample for that trip arrived after the
state machine had already silently timed out into `stopped`. The saved trip has
`points: 0` — no route, no elevation, no map — despite being a real ~11-minute,
2.8km ride (distance/duration still saved correctly, since those come from the
board's own odometer, not GPS).

BLE and GPS going *completely* dark *at the same instant*, for that long, isn't
signal/range flakiness (ruled out: the board was within 30cm, showing connected on
its own screen the whole time). It's the signature of Android suspending the app's
background execution entirely. Verified against Android's own documentation, not
assumed:

- [Background Location Limits](https://developer.android.com/about/versions/oreo/background-location-limits) (Android 8+, **"regardless of an app's target SDK
  version"**): an app with no active foreground service gets location updates
  "only a few times each hour" while backgrounded. This is a hard platform
  throttle — **not** battery optimization, **not** OEM "sleeping apps" / "deep
  sleep" lists (confirmed with the user: both were off, checked directly, not the
  cause here).
- [Restrictions on starting a foreground service from the background](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
  (Android 12+): an app cannot *start* a **new** foreground service while it has no
  visible activity — throws `ForegroundServiceStartNotAllowedException`. The exact
  error text from this exception appears verbatim in production logs: *"Foreground
  service cannot be started when the application is in the background."*

The bug: `stopLocationWatch()` called `stopForegroundService()` every time the JS
GPS watch had "no more reason to run" — the board disconnecting while idle, or a
trip ending with the board gone (battery-conscious by design: no point paying for a
location service with no board to ride). The service would then need to be started
**fresh** the next time it was needed — which happens from `subscribeWatch`,
triggered by a board (re)connection or a trip auto-start. Both of those can
legitimately fire while the phone is locked in a pocket: a board auto-reconnecting
on its own, or a trip auto-starting purely from the board's own wheel speed (BLE
push, no app interaction needed). Exactly the case Android 12+ refuses. When the
start failed, the app had no active foreground service, and Android's background
throttle above silently took over for as long as the app stayed backgrounded —
explaining the ~7-minute blackout precisely, including why everything unblocked the
instant the phone was picked up again.

## Decision

The foreground service starts **once, proactively, at app launch** (`initAutoTracking`,
gated on a board actually being paired — a fresh install with nothing paired yet
still shouldn't show a permanent notification for no reason) — not reactively, later,
in response to whatever event happens to need it first. App launch is a state
Android always considers "visible enough" to start a foreground service from, so this
sidesteps the background-start restriction entirely instead of racing it.

Once started, **the service is never stopped in response to board connection state**.
`stopLocationWatch()` still stops the actual GPS watch subscription (the real,
battery-relevant GPS chip activity — unchanged, still fully gated by board connection
and trip state exactly as before: idle-tier Balanced-accuracy polling only while a
board is connected, active-tier BestForNavigation only while actively riding,
nothing at all while disconnected). Only the **service registration** — the
lightweight, mostly-idle Android bookkeeping that keeps the app exempt from the
background-location throttle — now persists for the process's lifetime once
started. `subscribeWatch`'s own reactive call to `ensureForegroundServiceRunning`
stays in place as a fallback (idempotent no-op once the proactive start has already
landed), not removed — belt-and-suspenders in case the proactive one somehow
didn't run.

## Consequences

**Battery impact: small, and specifically NOT a GPS-polling increase.** The GPS
chip's actual activity (idle-tier polling, active-tier recording) is completely
unchanged — still fully gated by board connection and trip state, identical to
before this decision. What changed is purely the foreground-service *registration*
staying alive continuously instead of being torn down and restarted around every
connect/disconnect — Android's own recommended mechanism for exactly this kind of
legitimate continuous-tracking use case (the platform requires it specifically
*because* it's the accepted, bounded-cost way to keep an app exempt from the
background throttle above). The real, user-**visible** cost is the "Turbo is
tracking your location" notification now staying up continuously whenever a board
is paired, rather than disappearing when the board disconnects — a UX trade-off, not
a meaningful power one.

**Do not reintroduce stop/start cycling of the foreground service tied to board
connection or trip state.** If a future battery-optimization pass wants to reclaim
that notification-visibility cost, the fix must not touch the service's start/stop
lifecycle — instead, look at suppressing/customizing the *notification's visibility*
specifically (if the platform allows it) while keeping the underlying service
registration itself persistently alive. Reintroducing "stop the service when the
board disconnects" reopens the exact race this ADR closes.

See `lib/__tests__/notification-lifecycle.test.ts` for the regression tests pinning
this behavior (both "starts once a board is paired" and "does NOT stop on
disconnect").

**Addendum.** `startLocationUpdatesAsync(LOCATION_TASK_NAME, ...)` — the call this ADR
requires happen once, at launch, and never be undone — is not a cost-free registration.
It is a live, standing FusedLocationProviderClient request at `Accuracy.Balanced` / 3s
(`LOCATION_OPTIONS` in `lib/tripRecorder/location.ts`), for the entire process lifetime
once a board is paired. This ADR's own "battery impact: small, and specifically NOT a
GPS-polling increase" claim describes the *service registration* being cheap, not this
request — the request itself is real, ongoing GPS-adjacent cost, contradicting this
app's own "no continuous GPS while idle" invariant (`AGENTS.md`). A future change should
replace this with a request that is actually gated on ride state (none while idle, high
accuracy while riding) inside a foreground service that still follows this ADR's own
start-once-never-stop rule unchanged.
