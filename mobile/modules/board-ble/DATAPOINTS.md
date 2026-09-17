# Tynee board datapoint (DP) dictionary — current, verified reference

**Read this before adding, changing, or "fixing" any dpId mapping.** Every row below is
one of three things, and the table says which: **confirmed** (matched against Tuya's
own app, or watched moving live against a real board), **live-tested** (a write was
actually sent to a real board and the result observed), or **unconfirmed / guessed**
(inferred from a name or pattern, never independently verified). Treat "unconfirmed" as
a real warning, not a formality — see the History section below for what happened the
last two times a guess here went untested into shipped code.

Source of truth in code: `mobile/lib/boardDpSchema.ts` (`BOARD_DP_SCHEMA`, wire
type/range per dp) and `mobile/lib/boardDpLabels.ts` (`GLOBAL_DP`, human labels). This
file exists because *why* a mapping is what it is — and which ones are still open
questions — doesn't fit as inline code comments without becoming unreadable.

## Telemetry (read-only)

| dp | code | Meaning | Wire type | Status |
|---|---|---|---|---|
| 2 | `speed` | Current speed, km/h ×10 (scale 1) | value | confirmed |
| 3 | `battery` | Battery %, 0–100 | value | confirmed |
| 5 | `mileage_once` | Trip distance, km ×10 | value | confirmed |
| 6 | `ridetime_once` | Trip ride time, seconds | value | confirmed |
| 12 | `mileage_total` | Odometer, km ×10 | value | confirmed |
| 20 | `voltage` | Pack voltage, V ×10 | value | confirmed |
| 102 | `remote_power` | Remote controller's own battery %, distinct from dp3 | value | confirmed |

## Switches (writable)

| dp | code | Meaning | Wire type | Status |
|---|---|---|---|---|
| 1 | `blelock_switch` | Board lock | bool, **inverted polarity** | **Fully confirmed live.** dp1 genuinely immobilizes the board — matches Tuya's own app exactly (the wheel refuses to turn until unlocked). The write itself was correct from the start; what was wrong was assuming the raw boolean equals "locked" — it's the opposite: **`true` = unlocked, `false` = locked.** Read straight, this showed the exact inverted label on every press (offering "Lock" while already locked) even though the physical lock was working the entire time. `lib/boardQuickControls.ts`'s `useLockControl` and `lib/deviceLink.ts`'s `getBleSnapshot` (`lockOn`) both invert the raw read now. **Tuya's own lock does not survive a board power-cycle** (confirmed on Tuya's own app — a real Tuya limitation, not a bug) — this app deliberately does better: `useLockControl` persists the rider's last chosen lock intent (per board, in `AsyncStorage`) and re-applies it automatically on every reconnect, so a rider's lock choice actually holds across a power cycle even though the board's own memory doesn't. |
| 8 | `headlight_switch` | Headlight — 3 real physical states (off/static/blinking) | bool, **inverted, and asymmetric** | **Confirmed live, through several rounds of correction — see History below.** `true` reliably means **off** (board stays connected and ridable with the light dark) — both readable and directly settable. `false` means lit, but covers **both** static and blinking; a read cannot tell those two apart, and Tuya's own app itself never reaches off from its own toggle — it only rotates static↔blinking by repeatedly writing `false`. This app's `useHeadlightControl` never writes `true` either, matching Tuya: off is only ever reachable from the board's physical power button. Since the board genuinely can't report which lit sub-mode is active, "static vs blinking" is tracked client-side in shared module state (`lib/boardQuickControls.ts`) — shared, not per-component, so the FAB/device-settings/dashboard badge agree — and **persisted to disk per board**, because the board itself remembers which of static/blinking it was showing across its own power cycles (confirmed live), so this app's memory of the same fact needs to survive one too rather than resetting to a default guess. |
| 13 | `cruise_switch` | Cruise control (name per Tuya's own app; real effect unknown) | bool | **Confirmed non-functional, twice over — removed from the UI, do not re-add without a genuinely new signal.** Round 1: a write reaches the board (`dp13=true` briefly echoed back) but reverts to `false` on its own within single-digit milliseconds, every time — the rider confirmed Tuya's own app's cruise button is equally inert. Round 2: re-added under the hypothesis that it locks the board to ride mode 1 ("Legit Mode," for compliance/inspection). Disproven on two fronts live: (a) toggling dp13 from the app has no effect on ride-mode switching — `dp14` cycles freely through every level via the app regardless of dp13's state; (b) the rider separately found the *actual* physical trigger for the mode-1-lock behavior on the controller itself, and it produces **zero BLE traffic** — no dp13 flicker, no dp14 change, nothing at all in the DP stream — meaning it's a fully local/firmware-internal controller state with nothing observable over this link in either direction. There is currently no known way to read, set, or clear this behavior from the app. Do not re-guess a third time; this dp has now failed both a write-effect test and a passive-correlation test. |
| 107 | `autobrake` | R-LOS autobrake | bool | confirmed |

## Global settings (writable)

| dp | code | Meaning | Wire type | Status |
|---|---|---|---|---|
| 11 | `unit` | Distance unit | enum `['km','mile']` | confirmed |
| 14 | `ride_mode` | Riding mode | enum `['level_1'..'level_4']` → eco/ride/speed/turbo | confirmed |
| 101 | `direction` | Motor direction | enum `['forward','back']` | confirmed |
| 103 | `motor_type` | Motor type | enum `['hub','belt']` | confirmed |
| 104 | `wheel_diameter` | Wheel diameter, mm | value | confirmed |
| 105 | `motor_ratio` | Motor gear ratio | value | confirmed |
| 106 | `motor_pole_pairs` | Motor pole pairs | value | confirmed |
| 120 | `brake_power_max` | Max regen brake power, % | value (30–100, step 5) | confirmed |

## Per-mode speed limits / accel / decel

`108`–`111` (speed limits), `112`–`115` (acceleration), `116`–`119` (deceleration), one
each for eco/ride/speed/turbo in that order. Speed limit ranges are confirmed live;
the acceleration/deceleration dpIds' *identity* is confirmed (they move when the
corresponding board-config slider is saved) but their exact real-world effect curve is
not independently verified beyond "the board accepts the write."

## Investigated but not yet mapped to a dpId

Found by testing Tuya's own app's board device page directly (not yet matched to a
specific dp on this board):

- **A lock button** — see dp1 above; identity and effect both fully confirmed.
- **A cruise button** — see dp13 above; confirmed non-functional twice over, removed.
- **A controller-side "lock to mode 1" behavior**, triggered by a physical button
  sequence on the controller itself — real and reproducible, but produces zero BLE
  traffic when triggered, so there is nothing for this app to read, set, or clear.
  Not tied to dp13 or dp14 or any other known dp.
- **A headlight toggle** — see dp8 above; identity confirmed, working model for the
  3-state cycle live-tested but the static→blinking transition specifically is still a
  working theory, not independently confirmed.
- **A mode-select button** that opens a picker for the four ride levels — this is dp14,
  already confirmed and wired up (`useRideModeControl` in
  `mobile/lib/boardQuickControls.ts`).

If a genuinely new physical behavior turns up in Tuya's app that doesn't map cleanly to
an already-confirmed dp above, do not guess a dpId for it — log the raw DP stream
(`adb logcat` + the `board-link`/`dps` tag; see `PROTOCOL.md`'s testing section) while
triggering it from Tuya's own app, and read which dp actually changed.

## History — why "confirmed" matters here

- **dp8 (headlight), round 1**: shipped with a guessed 3-state `range` based on how
  Tuya's own app button *looked* like it behaved, never checked against an actual DP
  push. The guess made the headlight quick control invisible in the FAB/device-settings
  (its state never matched any of the three guessed labels) — root-caused from real
  `adb logcat` DP stream output showing dp8 as a plain boolean.
- **dp8, round 2**: reverted to a plain alternating `true`/`false` toggle — wrong again.
  On real hardware the light only ever bounced between two lit states and never
  actually went dark.
- **dp8, round 3**: tried sending the same `true` "advance" pulse on every press
  regardless of prior state — wrong a third time, got stuck showing blink only, never
  cycling further.
- **dp8, round 4 (current)**: went back to on-device testing one transition at a time
  instead of guessing a whole cycle at once — confirmed `false`→off and `true`-from-off→
  static individually first, *then* asked whether a second `true` reaches blink. This
  is the pattern that should have been used from round 1: verify one transition, not a
  whole hypothesized state machine, before shipping it.
- **dp1 (lock)**: never actually broken — the write was correct from commit one. What
  looked like "does nothing" was a **display bug**: the raw boolean was read as if
  `true` meant locked, when the board's actual polarity is the reverse. A control that
  appears completely non-functional is worth checking for an inverted read *before*
  assuming the write mechanism itself is wrong — the mechanism was fine the whole time.
- **Protocol version** (a related but distinct lesson, documented fully in
  `PROTOCOL.md`): every DP *write* silently failed for months of design work because
  the wrong SEND_DPS opcode (v3's `0x0002` instead of v4's `0x0027`) was used — the
  board doesn't error on a wrong opcode, it just never answers. A `NO_RESPONSE` from a
  write is not proof the dp is wrong or read-only; it can just as easily mean the wire
  shape itself is being spoken incorrectly.

**The pattern in both cases: the board never announces an error for something it
doesn't understand — it just stays silent, or answers something adjacent to what you
expected.** Every fact in this file and in `PROTOCOL.md` earned its "confirmed" label
by observing an actual DP push or an actual round-tripped write in `adb logcat`, not
by matching a plausible name or a plausible-looking Tuya app screen. Extend that
standard to anything added here later.
