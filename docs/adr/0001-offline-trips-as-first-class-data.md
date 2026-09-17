# 0001 — Offline trips are first-class data, not a pending queue

## Status

Accepted.

## Context

Trips are saved queue-first: the moment a ride ends, its data is written to a local
SQLite queue (`trip_queue`) before any network call, then synced to the backend in
the background. That part predates this decision and isn't in question.

What was missing: a trip sitting in that local queue — not yet synced, whether
because the backend was unreachable or the sync simply hadn't run yet — was
invisible everywhere except a "Sync now" button buried in Settings. The trips list,
activity charts, the dashboard's last-ride card, and the trip detail screen all read
exclusively from the backend (`useTrips`/`useTrip` → `api.listTrips`/`api.getTrip`).
A rider who just finished a ride with no signal saw nothing — not even confirmation
the ride was captured — until it happened to sync.

Separately, a real production bug (see `fix(trip-save)` commits) surfaced that a
save could fail *before* it even reached the local queue (a SQLite write failure,
`LocalEnqueueError`), and that the retry for a queued-but-not-yet-synced trip only
ran at app cold start, not on foreground return — closing that gap made "trip exists
locally but not on the backend yet" a state worth designing the UI around properly,
rather than a rare edge case to paper over.

## Decision

A trip is a trip regardless of where it lives. `useTrips()`/`useTrip()` merge the
local queue and the backend transparently:

- A locally-queued trip's `id` is the **negation of its `trip_queue.localId`** — real
  backend ids are always positive (Postgres serial), so this can never collide.
  `isLocalTripId(id) = id < 0`. This one convention is what makes every existing
  id-keyed screen (rides list, activity list, the dashboard's last-ride card, trip
  detail, the widget's cached last-ride) work with **zero changes** to their own
  logic — they just started rendering offline trips because the data layer started
  handing them over.
- `lib/localTrips.ts` maps a `trip_queue` row into the exact same `TripSummary`/
  `TripDetail` shape a synced trip has. Fields the backend computes
  (`dominantMode`/`modeMixed`) are computed client-side identically; fields only the
  backend can produce (`weatherCodes`, `snappedRoute`, elevation, cost-by-mode) are
  null/absent until sync.
- `useTrips()` merges the backend list and the local queue via `Promise.all`, but a
  **backend fetch failure degrades to an empty list, not a query failure** — the
  whole point of showing offline trips is that they must still be visible when the
  backend is unreachable, so a `Promise.all` that fails the entire query on a
  backend error would defeat the feature in exactly the scenario it exists for.
- The trip detail screen shows an "Upload trip to server" action for an unsynced
  trip, and a blur + "needs to sync" overlay (with its own retry button) in place of
  the backend-only sections (elevation, cost-by-mode) — rather than those sections
  just rendering empty, which reads as broken rather than "not synced yet."
- Sync retries run automatically on trip finish, app cold start, **and every
  foreground return** (closing the gap above), plus on demand via Settings' "Sync
  now" (retries every queued trip) and "Check for an interrupted trip"
  (`recoverInterruptedTrip`, for the rarer case where a trip never reached the local
  queue at all — a checkpoint-based recovery, gated on no ride currently being
  recorded).

## Consequences

- No new backend work was needed — the backend already had everything (weather,
  elevation, map-matching) computed server-side; this is entirely a mobile-side
  data-layer and UI change.
- Weather (see the backend's ADR 0002) and Health Connect vitals are captured
  on the phone anyway, so they're already correct on an offline trip — only
  elevation, road-snapping, and the cost-by-mode physics comparison are genuinely
  backend-only and stay locked until sync.
- Deleting and refreshing vitals are disabled on an unsynced trip (no backend id to
  act against yet) rather than silently failing.
- A narrow, self-healing race exists: if `useTrips()`'s two parallel reads
  (backend list, local queue) straddle the exact moment a sync completes
  (`api.createTrip` succeeded, `markSynced` hasn't committed yet), the same trip
  could theoretically appear twice for one query. Not worth guarding against — the
  window is milliseconds and the next refetch (focus, foreground, pull-to-refresh)
  self-corrects it.
