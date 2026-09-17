# 0007 — `DeviceProfile`: one interface per brand instead of brand checks in components

## Status

Accepted. Implemented for Tynee (Tuya Direct BLE) and NAVEE (V40i Pro Direct BLE).

## Context

Before NAVEE, every BLE-facing surface hard-assumed a Tynee board: the FAB's quick
actions, the dashboard's status pills, the ride-mode vocabulary shown in trip
details/planner/Range-by-mode, and the voltage graph's plausible range were all
written directly against Tynee's shape. Adding a second brand without an
abstraction would have meant forking or branching every one of those components on a
brand string, growing worse with each brand after.

Two things differ per brand:

- **Protocol-level**: how a device connects, authenticates, and encodes telemetry —
  native, per-brand modules (`modules/board-ble/`, `modules/navee-ble/`) and
  `mobile/src/features/device/deviceLink/transport.ts`. The transport is chosen by
  devId prefix rather than by a stored field: a NAVEE devId always carries a `navee-`
  prefix, so the choice needs no extra storage read.
- **Product-level**: what a device's ride modes are called, what quick actions it
  offers, what status pills apply, what pack voltage is even plausible. This is what
  `src/features/device/deviceProfile.ts`'s `DeviceProfile` interface exists for.

## Decision

`DeviceProfile` (`mobile/src/features/device/deviceProfile.ts`) is a plain data
interface, not a class hierarchy — a brand contributes one `DeviceProfile` value, not
a subtype:

```ts
type DeviceProfile = {
  brand: string;
  rideModes: readonly Mode[];
  rideModeLabel: (mode: Mode) => string;
  deviceIcon: 'skateboard' | 'scooter-electric';
  quickActions: readonly QuickActionKey[];
  statusExtras: readonly StatusExtraKey[];
  plausibleVoltageV: { min: number; max: number };
};
```

`profileForBrand`/`profileForDevId` look a brand or devId up in a `Record<string,
DeviceProfile>` keyed by brand — the same "table instead of branching" shape used at
the protocol level in `mobile/src/features/device/deviceLink/transport.ts`. Shared UI (the FAB, status
pills, trip details, the planner, the voltage graph) reads the active device's
profile instead of checking `brand === 'navee'` itself.

A third brand means adding one `DeviceProfile` value plus its native module — not
touching every component that currently reads `TYNEE`/`NAVEE` directly.

## Consequences

- Adding NAVEE's settings screen, FAB actions, and mode vocabulary took no changes to
  the shared components that render them — only a new profile value and new profile
  fields where a genuinely new axis showed up (`statusExtras`, `plausibleVoltageV`).
- Range/efficiency math deliberately stayed **out** of `DeviceProfile`. It is
  server-side and per-device already (the backend's `DeviceSetting`), not a per-brand
  constant, so folding it into this interface would have duplicated a concept that
  already exists at the right layer.
- The mode vocabulary itself (`mobile/src/lib/mode.ts`'s `Mode`/`MODE_META`) is still
  a single shared enum across brands, not per-profile — a brand's `rideModes` is a
  subset or relabeling of that shared set, not its own vocabulary. Generalizing the
  backend's hardcoded Tynee mode vocabulary (`LEVEL_TO_MODE`/`ALL_MODES` in its
  `app/core/constants.py`) was deliberately not attempted here.
