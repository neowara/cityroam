// Shared read/write logic for the board's quick controls (lock, headlight, cruise,
// ride mode) — used by both the FAB menu and board-config.tsx so the two surfaces
// can't drift on how state is derived or how a write is sent.
//
// These controls are only ever shown while the board is genuinely connected (see
// FloatingTripButton.tsx's quickControlsAvailable / board-config's own online gate),
// so unlike board-config's batched settings there is nothing to queue for a
// reconnect — a press writes straight to the board over the open BLE link. Every
// control still mirrors the board's own reported dp value rather than flipping the UI
// optimistically on press: the rendered value only ever comes from useBleRawDps(),
// never from local state set by the press handler itself.

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { getPairedDeviceId, useBleRawDps, writeBleDp } from '@/features/device/deviceLink';
import { subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';
import { GLOBAL_DP } from '@/features/device/boardDpLabels';
import { decodeMode, encodeMode, type Mode } from '@/lib/mode';
import { hapticBlinkPulse, hapticBoardControl } from '@/lib/haptics';
import { logEvent } from '@/lib/log';
import { isNaveeDevId } from '@/features/device/navee/credentials';

/** The sending/error bookkeeping every quick control needs around its one write —
 * `haptic` defaults on since lock/cruise/headlight all want the "this really went out"
 * buzz at write time; ride-mode's select() opts out explicitly (haptic: false).
 * Exported for brand-specific controls (lib/navee/quickControls.ts). */
export function useDeviceWrite(): {
  sending: boolean;
  error: string | null;
  run: (write: () => Promise<void>, opts?: { haptic?: boolean }) => Promise<void>;
} {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (write: () => Promise<void>, opts?: { haptic?: boolean }) => {
    setSending(true);
    setError(null);
    if (opts?.haptic !== false) hapticBoardControl();
    try {
      await write();
    } catch (err) {
      setError(err instanceof Error ? err.message.split('\n')[0] : String(err));
    } finally {
      setSending(false);
    }
  };

  return { sending, error, run };
}

type BoolSwitch = {
  value: boolean | null;
  sending: boolean;
  error: string | null;
  set: (next: boolean) => Promise<void>;
};

function useBoolSwitch(dpId: string): BoolSwitch {
  const rawDps = useBleRawDps();
  const { sending, error, run } = useDeviceWrite();

  const raw = rawDps?.[dpId];
  const value = typeof raw === 'boolean' ? raw : null;

  const set = (next: boolean) => run(() => writeBleDp(dpId, next));

  return { value, sending, error, set };
}

export type LockControl = { locked: boolean | null; sending: boolean; error: string | null; toggle: () => Promise<void> };

// Confirmed live: dp1 actually does immobilize the board (matches Tuya's own app) —
// but its raw wire polarity is the OPPOSITE of what the name suggests: `true` means
// unlocked, `false` means locked. Reading it straight (raw === locked) showed the
// inverted label on every press (offering "Lock" while already locked, "Unlock" while
// already unlocked) even though the write itself was working correctly the whole time.
export function useLockControl(): LockControl {
  const s = useBoolSwitch(GLOBAL_DP.lock);
  const locked = s.value == null ? null : !s.value;
  const toggle = async () => {
    const nextRaw = !(s.value ?? false);
    await s.set(nextRaw);
    const devId = await getPairedDeviceId();
    if (devId) void setLockIntent(devId, !nextRaw);
  };
  return { locked, sending: s.sending, error: s.error, toggle };
}

// Tuya's own lock does not survive a board power-cycle — a rider who
// locked their board would otherwise find it silently unlocked again the next time it
// reconnects, with nothing telling them it reverted. This remembers the rider's last
// chosen lock state per board (independent of whether the board itself remembers it)
// and re-applies it every time that board reconnects. Only ever fires for a board the
// rider has actually pressed Lock/Unlock on through this app — never writes dp1
// unsolicited for a board whose lock state nobody here has ever touched.
const LOCK_INTENT_KEY = 'tynee.lockIntent';

async function getLockIntents(): Promise<Record<string, boolean>> {
  try {
    const raw = await AsyncStorage.getItem(LOCK_INTENT_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function setLockIntent(devId: string, locked: boolean): Promise<void> {
  const intents = await getLockIntents();
  intents[devId] = locked;
  await AsyncStorage.setItem(LOCK_INTENT_KEY, JSON.stringify(intents));
}

subscribeToBleConnectionTransitions(async (event) => {
  if (event.type !== 'connected') return;
  // Only the board forgets its lock on a power-cycle. Re-sending a lock on every NAVEE
  // reconnect could lock a scooter that was unlocked elsewhere, possibly mid-ride.
  if (isNaveeDevId(event.devId)) return;
  const intents = await getLockIntents();
  const intendedLocked = intents[event.devId];
  if (intendedLocked == null) return;
  try {
    // Raw wire polarity is inverted: true = unlocked, false = locked.
    await writeBleDp(GLOBAL_DP.lock, !intendedLocked);
    logEvent('board-lock', `reapplied persisted lock intent on reconnect: ${intendedLocked ? 'locked' : 'unlocked'}`, {
      devId: event.devId,
    });
  } catch (err) {
    // Best-effort — the next successful connect retries from the same persisted intent.
    logEvent('board-lock', 'failed to reapply persisted lock intent on reconnect', {
      devId: event.devId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export type HeadlightMode = 'off' | 'static' | 'blinking';

// dp8 is a bool, but `true` and `false` are not symmetric: `true` reliably means off —
// readable AND settable (board stays connected and ridable with the
// light dark) — while `false` covers BOTH lit sub-modes, which a read genuinely can't
// tell apart from each other. Via this app, the ONLY reachable transition is
// static<->blinking (never off) — but the wire mechanism to actually produce that
// transition is an alternating true/false write (confirmed required: repeating the
// same value is a no-op on this firmware), so a press causes dp8 to report the
// board's own "off" value as a side effect of that mechanism, WITHOUT the light
// actually going dark — and, that reported value does not reliably
// settle back on any fixed timescale (an earlier fixed-cooldown approach here was
// wrong: dp8 kept reading as this app's own "true" long enough that a real off
// happening later looked identical). The only reliable way to tell "this true is my
// own write settling" from "this true is a genuine external off" is to track what
// value THIS control itself last wrote and compare — see isGenuineOffRead below.
//
// "Which lit sub-mode" is remembered client-side, in shared module state (not a
// per-component useState — the FAB, board-config, and the dashboard's read-only status
// badge each mount their own hook instance, and they'd disagree if each kept its own
// memory), persisted to disk per board so an app restart while the light is still on
// doesn't forget which sub-mode this app itself last selected. It's reset to 'static'
// (never left null, and never guessed as 'blinking') the instant a GENUINE off is
// observed — a real off, from the physical power button or another app, invalidates
// the guess, since this app has no way to know which sub-mode the light will resume
// in once it's back on; 'static' ("Light On") is the one deterministic reset point
// every off resolves to for both the FAB button and the dashboard's status badge.
let headlightSubMode: 'static' | 'blinking' | null = null;
const headlightSubModeListeners = new Set<() => void>();
const HEADLIGHT_SUBMODE_KEY = 'tynee.headlightSubMode';

// The exact wire value this control's own toggle() last sent — null until the first
// press this session. A raw `true` read that MATCHES this is this app's own write
// still in effect (the light is still lit, in whichever sub-mode that write produced),
// not a real off. Only a `true` read that DIFFERS from what this app itself last
// intentionally wrote means something else (the physical power button, another app)
// changed it — that is the one case genuinely worth calling "off".
let headlightLastWrittenValue: boolean | null = null;

function isGenuineOffRead(isOff: boolean | null): boolean {
  return isOff === true && headlightLastWrittenValue !== true;
}

function setHeadlightSubMode(next: 'static' | 'blinking' | null): void {
  headlightSubMode = next;
  headlightSubModeListeners.forEach((l) => l());
  void getPairedDeviceId().then(async (devId) => {
    if (!devId) return;
    try {
      const raw = await AsyncStorage.getItem(HEADLIGHT_SUBMODE_KEY);
      const map = raw ? JSON.parse(raw) : {};
      if (next == null) delete map[devId];
      else map[devId] = next;
      await AsyncStorage.setItem(HEADLIGHT_SUBMODE_KEY, JSON.stringify(map));
    } catch {
      // Best-effort — worst case the next reconnect falls back to the 'static' default.
    }
  });
}

function useSharedHeadlightSubMode(): 'static' | 'blinking' | null {
  const [state, setState] = useState(headlightSubMode);
  useEffect(() => {
    setState(headlightSubMode); // may have changed between render and effect
    const listener = () => setState(headlightSubMode);
    headlightSubModeListeners.add(listener);
    // Hydrates from disk once per process, only if nothing has set it in-memory yet
    // (a real press during this session is always more current than a stored guess).
    if (headlightSubMode == null) {
      void getPairedDeviceId().then(async (devId) => {
        if (!devId || headlightSubMode != null) return;
        try {
          const raw = await AsyncStorage.getItem(HEADLIGHT_SUBMODE_KEY);
          const map = raw ? JSON.parse(raw) : {};
          const stored = map[devId];
          if ((stored === 'static' || stored === 'blinking') && headlightSubMode == null) {
            headlightSubMode = stored;
            headlightSubModeListeners.forEach((l) => l());
          }
        } catch {
          // No stored guess — defaults to 'static' at the call site below.
        }
      });
    }
    return () => {
      headlightSubModeListeners.delete(listener);
    };
  }, []);
  return state;
}

function useHeadlightRaw(): boolean | null {
  const rawDps = useBleRawDps();
  const raw = rawDps?.[GLOBAL_DP.headlight];
  return typeof raw === 'boolean' ? raw : null; // true = off
}

export type HeadlightButtonMode = 'static' | 'blinking';

/**
 * The interactive control (FAB button, board-config tile) — this is NOT the same
 * thing as the board's true status. It only ever shows/cycles `static`/`blinking`
 * and can never display or select `off`, because off is only ever reachable from the
 * board's own physical power button, never from a touch in this app.
 *
 * The write underneath still has to alternate `true`/`false` on the wire — confirmed
 * live, repeating the same value is a no-op on this firmware, so that alternation is
 * what actually produces a real state change and is genuinely required to reach
 * blinking at all. That means a press can transiently leave the board's own dp8
 * reporting what it calls "off" — this control deliberately ignores that and keeps
 * showing whichever lit sub-mode it last selected, so the touch UI itself never
 * exposes a state the user can't reach through it. The real off status (from the
 * board's own report) is surfaced separately, only on the dashboard's passive status
 * badge — see useHeadlightStatus below.
 */
export function useHeadlightControl(): { mode: HeadlightButtonMode; sending: boolean; error: string | null; toggle: () => Promise<void> } {
  const { sending, error, run } = useDeviceWrite();
  const subMode = useSharedHeadlightSubMode();
  const isOff = useHeadlightRaw();
  // Never null, even before the first dp8 read arrives — this is the button, not the
  // true-status badge, and it must never render (or be momentarily indistinguishable
  // from) the off-looking icon. 'static' ("Light On") is the reset point every genuine
  // off resolves to (see useHeadlightStatus's effect), so it's also the right default
  // before anything is known yet.
  const mode: HeadlightButtonMode = subMode ?? 'static';

  const toggle = () => {
    // Raw `isOff` alone can't tell "genuinely off" from "this control's own last
    // write, currently reporting true because that's the wire value 'blinking'
    // happens to be" — same ambiguity isGenuineOffRead exists to resolve. A press
    // while genuinely off means "turn on to static"; a press while already on (in
    // either sub-mode, tracked locally) means "alternate to the other sub-mode".
    const turningOnFromGenuineOff = isGenuineOffRead(isOff);
    const nextSubMode: HeadlightButtonMode = turningOnFromGenuineOff ? 'static' : mode === 'blinking' ? 'static' : 'blinking';
    const nextRaw = !(isOff ?? false);
    return run(() => writeBleDp(GLOBAL_DP.headlight, nextRaw)).then(() => {
      headlightLastWrittenValue = nextRaw;
      setHeadlightSubMode(nextSubMode);
    });
  };

  return { mode, sending, error, toggle };
}

/** Read-only, real board status for the dashboard's passive status badge — the ONLY
 * surface `off` is ever shown on. Never used for an interactive control (see
 * useHeadlightControl above).
 *
 * "blinking" is only ever shown once this app's own toggle has actually set it — the
 * board can turn the light on via its physical power button with no way for this app
 * to know which lit sub-mode it landed on, so defaulting an unknown state to
 * "blinking" would routinely show a guess as if it were a fact. Resets the shared
 * sub-mode to "static" (not blinking, and not null — "static" is the single reset
 * point every genuine off resolves to, matching useHeadlightControl's own default)
 * the instant a GENUINE off is observed — see isGenuineOffRead/headlightLastWrittenValue
 * above: a `true` read that matches what this app's own toggle last wrote is that
 * write's own value still in effect, not a real off, and must not reset anything.
 * Mounted once at the app root via useHeadlightBlinkHaptic, so this reset runs
 * continuously regardless of which screen is open — including the FAB button, which
 * reads the same shared sub-mode and will itself show "Light On" the moment this
 * fires. Also never *reports* off for that same self-written value, for the same
 * reason: the light never actually went dark, so the pill shouldn't flash "off". */
export function useHeadlightStatus(): HeadlightMode | null {
  const subMode = useSharedHeadlightSubMode();
  const isOff = useHeadlightRaw();
  const genuineOff = isGenuineOffRead(isOff);

  useEffect(() => {
    if (genuineOff && headlightSubMode !== 'static') setHeadlightSubMode('static');
  }, [genuineOff]);

  return isOff == null ? null : genuineOff ? 'off' : (subMode ?? 'static');
}

// Shared with HeadlightButtonIcon's fill-toggle animation, so the buzz and the visual
// flash land together — exported rather than duplicated as a magic number there.
export const BLINK_HAPTIC_INTERVAL_MS = 700;

/** Drives a light, repeating haptic tick for as long as the headlight is blinking.
 * Mount exactly once, at the app root (see app/_layout.tsx) — every UI surface that
 * shows headlight status (FAB, board-config, dashboard) reads the same live mode, so
 * mounting this per-surface would fire overlapping vibrations every time more than
 * one happened to be on screen at once. */
export function useHeadlightBlinkHaptic(): void {
  const mode = useHeadlightStatus();
  useEffect(() => {
    if (mode !== 'blinking') return;
    const interval = setInterval(hapticBlinkPulse, BLINK_HAPTIC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [mode]);
}

export type RideModeControl = {
  mode: Mode | null;
  sending: boolean;
  error: string | null;
  select: (next: Mode) => Promise<void>;
};

export function useRideModeControl(): RideModeControl {
  const rawDps = useBleRawDps();
  const { sending, error, run } = useDeviceWrite();

  const raw = rawDps?.[GLOBAL_DP.rideMode];
  const mode: Mode | null = typeof raw === 'string' ? decodeMode(raw) : null;

  // No haptic here — only the FAB/device-settings's lock/cruise/headlight toggles are
  // meant to buzz on write.
  const select = (next: Mode) => run(() => writeBleDp(GLOBAL_DP.rideMode, encodeMode(next)), { haptic: false });

  return { mode, sending, error, select };
}
