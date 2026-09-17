# 0003 — Connection reliability: bounded requests, honest liveness, no silent leaks

## Status

Accepted.

## Context

A full-codebase review (parallel agent audit across BLE/widget logic, mobile UI,
backend physics/range, backend auth/security) surfaced several independent
reliability defects, all in the same family: something that looked "connected" or
"working" wasn't, silently, with no error and no user-visible signal.

- **`lib/api/client.ts`'s `request()` had no timeout.** React Native's `fetch`
  doesn't time out on its own — a weak/flaky connection didn't fail, it hung,
  sometimes for minutes, with nothing for `saveAndSyncTrip` (or any other caller) to
  catch and react to. A hung trip upload reads identically to "nothing is
  happening," which is exactly the complaint that started this investigation.
- **`getBleSnapshot()` only checked `session.online === false`**, treating the
  `null` ("not yet confirmed either way") state as online. Combined with the DP
  cache being populated purely from an AsyncStorage-hydrated disk cache at app
  start — potentially days old — a cold start with a previously-paired board now
  out of range reported `online: true` with stale speed/battery/odometer to both the
  live speedometer and the trip recorder's own snapshot polling.
  `widgetSync.ts`'s `boardIsReporting()` already guarded against exactly this (its
  own comment documents the trap); `getBleSnapshot()` just didn't apply the same
  guard.
- **`subscribeWatch`** (the GPS watch idle/active tier handover) mutated
  module-level state with no concurrency guard. Two overlapping calls — e.g.
  `auto_start`'s escalation to the active tier racing `ensureLocationTrackingAlive`'s
  unconditional self-heal restart, plausible around the same foreground-return
  moment — could each read the same stale "outgoing" subscription before either
  resolved its own (documented as possibly minutes-long) `watchPositionAsync` call.
  Whichever resolved *second* silently overwrote the current subscription, orphaning
  the first: still alive, still delivering samples, referenced by nothing, so
  nothing — not even `stopLocationWatch` at trip end — could ever remove it.
- **`refreshLiveWeatherIfNeeded`** (the widget's live-ride weather badge) stamped
  its "fetched for this key" cooldown *before* the fetch resolved, and never reset
  it on failure. One rejected or empty request blocked every retry for the full
  15-minute refresh window — most of a typical ride — even once connectivity
  recovered.
- **`activateBleDevice`** wiped a custom board name back to the raw SDK string on
  every re-pair (see ADR 0002) — a reliability defect in the same spirit: something
  that should have persisted silently didn't.
- Settings' "Check for an interrupted trip" button called `recoverInterruptedTrip()`
  with no guard against a ride actively recording — that function blindly finalizes
  whatever checkpoint is on disk, with no notion of "a ride is in progress" (that's
  correct for its real job, post-crash recovery at app launch, where nothing is
  recording). Tapping it mid-ride would have finalized the in-progress ride
  prematurely while the real ride kept going and got saved again — a duplicate/
  corruption bug caught before shipping.

## Decision

Fix each at its source, matching the pattern the codebase already uses elsewhere for
the same class of problem, rather than adding a generic retry/timeout framework:

- Every backend request now aborts after 20s via `AbortController` — a bad
  connection fails fast and clearly into the existing retry-queue path instead of
  hanging indefinitely.
- `getBleSnapshot()` now requires `session.online === true && session.dpsLive`,
  matching `boardIsReporting()`'s contract exactly.
- `subscribeWatch` uses a generation counter: a call that resolves after a newer
  call has already won tears its own subscription down instead of installing it.
- `refreshLiveWeatherIfNeeded`'s cooldown only arms on a genuinely successful
  result; concurrent calls for the same key join one in-flight request instead of
  duplicating.
- `activateBleDevice` preserves an existing name (local or backend) across
  re-activation — see ADR 0002.
- The interrupted-trip check is gated on `tripRecorder`'s state being `idle`, same
  as the automatic foreground-triggered call already was.

## Consequences

- None of these fixes changed a public contract or a wire shape — all internal
  correctness fixes, each with a regression test pinning the specific race/timing
  bug it closes.
- The request timeout (20s) is a judgment call — long enough for a normal trip
  upload on a slow connection, short enough that a genuinely dead connection
  surfaces quickly. Revisit if a real trip payload ever needs longer in practice.
- These were all found by a systematic audit, not a single bug report — worth
  repeating this kind of pass periodically rather than only reactively, given how
  many of these were silent (no crash, no error, just quietly wrong).
