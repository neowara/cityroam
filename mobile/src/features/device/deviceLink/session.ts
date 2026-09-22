import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { emitBleConnectionTransition, subscribeToBleConnectionTransitions } from '@/features/device/deviceLink/connectionEvents';
import { ensureBlePermissions, hasBlePermissions } from '@/features/device/deviceLink/permissions';
import { logEvent } from '@/lib/log';
import { dropImplausibleDps } from '@/features/device/deviceLink/plausibleDps';
import { migrateOnce } from '@/lib/storageMigration';
import NaveeBleNative from '@modules/navee-ble/src/NaveeBle';
import { loadBoardCredentials, saveBoardCredentials } from '@/features/device/boardCredentials';
import { isNaveeDevId, loadNaveeCredentials, saveNaveeCredentials } from '@/features/device/navee/credentials';
import { NAVEE_DP_SCHEMA } from '@/features/device/navee/settings';
import BoardBleNative from '@modules/board-ble/src/BoardBle';
import {
  addDirectListener,
  directConnectionPhase,
  directDisconnect,
  directIsConnected,
  stopAllBackgroundReconnect,
} from '@/features/device/deviceLink/transport';
import { BOARD_DP_SCHEMA, resolveEnumDps, type BoardDpSchema } from '@/features/device/boardDpSchema';
// Circular by design: deviceLink imports this module (and re-exports it via
// `export *`), and this module calls back into deviceLink's writeBleDp/
// getBoardUsability from writeBoardSetting below. Safe because both are `function`
// declarations (hoisted, bound before either module's body runs) and are only
// invoked lazily inside async function bodies here, never at module-eval time.
import { getBoardUsability, writeBleDp } from '@/features/device/deviceLink';

// One shared session object, registered once per devId, so every subscriber
// (Dashboard, Settings) reads the same connection/dps state instead of racing
// independent copies.
//
// Multiple boards can be paired, but only one is ever "active" (registered/
// connected) at a time; `state` always describes that one device. Per-device
// persistence (dp cache, pending settings) is keyed by devId so switching the
// active device never leaks one board's cached values/queued writes into another's.

const DP_CACHE_KEY_PREFIX = 'tynee.boardDpCache.';
const PENDING_SETTINGS_KEY_PREFIX = 'tynee.pendingBoardSettings.';
// Pre-multi-device flat keys — migrated into the first-ever registered device's
// per-device slot below, then removed, so an existing install's cached dps/queued
// settings survive the upgrade instead of silently vanishing.
const LEGACY_DP_CACHE_KEY = 'tynee.boardDpCache';
const LEGACY_PENDING_SETTINGS_KEY = 'tynee.pendingBoardSettings';

function dpCacheKeyFor(devId: string): string {
  return `${DP_CACHE_KEY_PREFIX}${devId}`;
}

// Duplicated from deviceLink rather than imported: that module re-exports this one,
// so importing back would close a require cycle.
const ACTIVE_DEVICE_KEY = 'tynee.activeBleDeviceId';

/**
 * The device queued settings belong to.
 *
 * registeredDevId is only set once something has asked for a live session, which the
 * Settings screen does not necessarily do — so keying the queue off it alone meant a
 * saved-while-offline setting was invisible after a restart, and worse, a new one was
 * dropped rather than queued. The persisted active device is the durable answer.
 */
async function pendingSettingsDevId(): Promise<string | null> {
  return registeredDevId ?? (await AsyncStorage.getItem(ACTIVE_DEVICE_KEY));
}

function pendingSettingsKeyFor(devId: string): string {
  return `${PENDING_SETTINGS_KEY_PREFIX}${devId}`;
}

/** Copies a legacy flat key into `devId`'s own slot the first time that device is
 * ever registered, then deletes the legacy key — a one-time upgrade step so an
 * existing install's cached dps/queued settings survive. Shares migrateOnce's
 * already-migrated guard with deviceLink's legacy-pairing migration instead of
 * each re-implementing the same check. */
function migrateLegacyKey(legacyKey: string, newKey: string): Promise<void> {
  return migrateOnce(newKey, async () => {
    const legacy = await AsyncStorage.getItem(legacyKey);
    if (legacy == null) return;
    await AsyncStorage.setItem(newKey, legacy);
    await AsyncStorage.removeItem(legacyKey);
  });
}

/** What a board setting can be on the wire: a bounded/plain numeric, an enum label,
 * or a switch. Booleans matter because the queue has to hold them too — the autobrake
 * toggle is a setting like any other and must survive an offline save. */
export type BoardSettingValue = number | string | boolean;

export type SessionState = {
  paired: boolean;
  online: boolean | null;
  charging: boolean | null;
  searchingTimeout: boolean;
  dps: Record<string, unknown> | null;
  /** Per-dpId product schema — null until first fetch, empty object if not yet synced. */
  schema: Record<string, BoardDpSchema> | null;
  /** dpId -> value saved while offline; only fields the user explicitly touched, never a full-state sync. */
  pendingSettings: Record<string, BoardSettingValue>;
  /** True once the board itself has pushed telemetry over BLE this process lifetime.
   * `dps` is also hydrated from disk at startup (hydrateDpsCache), so a populated map
   * on its own says nothing about whether the board is actually reporting — it may be
   * days old. Consumers that must show genuinely live telemetry rather than a
   * last-known value (the home-screen widget) gate on this; consumers that are happy
   * with last-known (the paired-device list's battery column) ignore it. */
  dpsLive: boolean;
  /** True when the rider declined the Bluetooth permission, so the board can never be
   * found. Distinct from a genuine search timeout: the UI offers a retry that
   * re-prompts, rather than telling the rider to go wake a board that is already on. */
  permissionDenied: boolean;
};

const SEARCH_TIMEOUT_MS = 10_000;

let state: SessionState = {
  paired: false,
  online: null,
  charging: null,
  searchingTimeout: false,
  dps: null,
  schema: null,
  pendingSettings: {},
  dpsLive: false,
  permissionDenied: false,
};
let registeredDevId: string | null = null;
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let schemaRetryTimeout: ReturnType<typeof setTimeout> | null = null;
let hydratePromise: Promise<void> | null = null;
let hydratePendingPromise: Promise<void> | null = null;
const listeners = new Set<(s: SessionState) => void>();
// Unsubscribe fns keyed by devId, so resetBleSession can tear down a forgotten device's listeners.
const listenerCleanup = new Map<string, (() => void)[]>();

function notify() {
  listeners.forEach((l) => l(state));
}

function deriveCharging(dps: Record<string, unknown> | null, schema: Record<string, BoardDpSchema> | null): boolean | null {
  if (!dps || !schema) return null;
  const chargingEntry = Object.values(schema).find((entry) => /charg/i.test(`${entry.code} ${entry.name}`));
  if (!chargingEntry) return null;
  const value = dps[chargingEntry.id];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return /^(charging|charge|on|true|1)$/i.test(value);
  if (typeof value === 'number') return value === 1;
  return null;
}

// A connected board pushes dps several times a second (speed, especially) — persisting
// the whole cache to AsyncStorage on every single push is several disk writes a second
// for the length of a ride, none of which need to be that fresh (the in-memory `state`
// itself already is; this write only matters for surviving a process kill or a cold
// start). Throttled to at most one write every DP_CACHE_PERSIST_THROTTLE_MS, plus
// flushed immediately wherever staying more than a few seconds stale would actually
// cost something: the board disconnecting, and the app backgrounding.
const DP_CACHE_PERSIST_THROTTLE_MS = 5_000;
let lastDpCachePersistMs = 0;
let dpCachePersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistDpCacheNow(): void {
  if (!registeredDevId || !state.dps) return;
  lastDpCachePersistMs = Date.now();
  AsyncStorage.setItem(dpCacheKeyFor(registeredDevId), JSON.stringify(state.dps)).catch(() => {});
}

function schedulePersistDpCache(): void {
  if (!registeredDevId) return;
  const elapsed = Date.now() - lastDpCachePersistMs;
  if (elapsed >= DP_CACHE_PERSIST_THROTTLE_MS) {
    persistDpCacheNow();
    return;
  }
  if (dpCachePersistTimer) return;
  dpCachePersistTimer = setTimeout(() => {
    dpCachePersistTimer = null;
    persistDpCacheNow();
  }, DP_CACHE_PERSIST_THROTTLE_MS - elapsed);
}

/** Bypasses the throttle above — called wherever leaving the last dp push unwritten for
 * up to DP_CACHE_PERSIST_THROTTLE_MS would actually lose something worth having: the
 * board going offline (a cold-start read should see its last real telemetry, not
 * whatever was persisted several seconds before disconnect), and the app backgrounding
 * (a process kill while backgrounded must not lose the freshest reading). */
function flushDpCachePersist(): void {
  if (dpCachePersistTimer) {
    clearTimeout(dpCachePersistTimer);
    dpCachePersistTimer = null;
  }
  persistDpCacheNow();
}

if (AppState.currentState !== 'active') flushDpCachePersist();
AppState.addEventListener('change', (nextState) => {
  if (nextState !== 'active') flushDpCachePersist();
});

function setState(patch: Partial<SessionState>) {
  state = { ...state, ...patch };
  if ('dps' in patch || 'schema' in patch) state.charging = deriveCharging(state.dps, state.schema);
  notify();
  // registeredDevId is the only device `state` can coherently describe once
  // hydrateDpsCache's explicit-devId hydration below has run at least once, since
  // that's the point a plain devId-less write (a live onDpUpdate push) needs a key.
  if (patch.dps && registeredDevId) schedulePersistDpCache();
  if (patch.online === false) flushDpCachePersist();
}

/** `devId` is explicit, not read from `registeredDevId` — this can be called
 * (via ensureDpsHydrated) before any component has registered a live session,
 * e.g. a background snapshot read right after app start. */
async function hydrateDpsCache(devId: string): Promise<void> {
  await migrateLegacyKey(LEGACY_DP_CACHE_KEY, dpCacheKeyFor(devId));
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    if (state.dps) return; // already populated this session (e.g. from activation)
    const raw = await AsyncStorage.getItem(dpCacheKeyFor(devId));
    if (!raw) return;
    try {
      state = { ...state, dps: JSON.parse(raw) };
      notify();
    } catch {
      // Corrupt cache — ignore, a live update repopulates it.
    }
  })();
  return hydratePromise;
}

/** Called directly from activateBleDevice() so registration is deterministic —
 * components mounted before pairing never re-run their empty-deps mount effect. */
export function registerPairedDevice(devId: string): void {
  ensureRegistered(devId);
}

/** Set by an explicit rider "Disconnect". Every screen that needs telemetry calls
 * registerPairedDevice on mount, so without this latch the next mount would silently
 * reconnect and the button would look broken. Cleared only by an explicit reconnect. */
let manuallyDisconnected = false;

export function isManuallyDisconnected(): boolean {
  return manuallyDisconnected;
}

/** Best-effort wrapper around the native stop-background-reconnect call, shared by the
 * two places that actually mean to stop it: an explicit rider "Disconnect"
 * (holdDisconnected) and "Forget" (resetBleSession). teardownRegisteredDevice itself no
 * longer calls this — see its own doc comment for why. */
function stopBackgroundReconnectSafely(): void {
  stopAllBackgroundReconnect();
}

/** Rider asked to disconnect: stop the native client and hold it down. */
export function holdDisconnected(): void {
  manuallyDisconnected = true;
  teardownRegisteredDevice();
  stopBackgroundReconnectSafely();
  // teardown resets state to "nothing paired"; the board is still paired, it is just
  // no longer connected. setState notifies on its own.
  setState({ paired: true, online: false });
}

/** Rider asked to reconnect, so release the latch. */
export function clearDisconnectHold(): void {
  manuallyDisconnected = false;
}

/** Idempotent — safe to call from every component that needs a live connection;
 * only the first call for a given devId actually registers anything. */
function ensureRegistered(devId: string) {
  if (manuallyDisconnected) return;
  if (registeredDevId === devId) return;
  registeredDevId = devId;
  setState({
    paired: true,
    online: null,
    charging: null,
    searchingTimeout: false,
    dps: null,
    schema: null,
    dpsLive: false,
    permissionDenied: false,
  });
  startSearchTimeout(devId);

  registerDirectSession(devId);
  // Retrying fetch, not a single opportunistic call — schema also feeds deriveCharging(), needed app-wide, not just on board-config.tsx.
  ensureSchemaLoaded(devId);
}

/** SDK-free registration: the native client owns scanning, the handshake, and
 * reconnect-with-backoff; this side only maps its events onto the shared session
 * state and hands it the stored key material once. */
function registerDirectSession(devId: string): void {
  const statusSub = addDirectListener('onDirectConnectionChanged', (event) => {
    if (registeredDevId !== devId || event.devId !== devId) return;
    const wasOnline = state.online === true;
    if (event.connected) {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = null;
      setState({ online: true, searchingTimeout: false });
      if (!wasOnline) emitBleConnectionTransition({ type: 'connected', devId });
    } else {
      setState({ online: false });
      if (wasOnline) emitBleConnectionTransition({ type: 'disconnected', devId });
    }
  });
  const dpUpdateSub = addDirectListener('onDirectDpUpdate', (event) => {
    if (event.devId !== devId) return;
    const wasOnline = state.online === true;
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = null;
    setState({
      online: true,
      searchingTimeout: false,
      dps: { ...(state.dps ?? {}), ...dropImplausibleDps(state.dps, resolveEnumDps(event.dps)) },
      dpsLive: true,
    });
    if (!wasOnline) emitBleConnectionTransition({ type: 'connected', devId });
  });
  // Tuya's API never returns the board's Bluetooth address, so it is only ever learned
  // by scanning. Storing it turns every later reconnect from a timer-driven scan into a
  // parked autoConnect: the board is picked up the moment it advertises, and the phone
  // stops running a 15s scan on a loop while the board is simply away.
  const addressSub = addDirectListener('onDirectAddressDiscovered', (event) => {
    if (event.devId !== devId || !event.address) return;
    void (async () => {
      if (isNaveeDevId(devId)) {
        const stored = await loadNaveeCredentials(devId);
        if (!stored || (stored.address && stored.addressType != null)) return;
        await saveNaveeCredentials({ ...stored, address: event.address, addressType: event.addressType });
        logEvent('board-link', 'learned the scooter address — later reconnects can skip scanning', {
          devId,
          address: event.address,
          addressType: event.addressType,
        });
        return;
      }
      const stored = await loadBoardCredentials(devId);
      // Also fills in the address type on an existing record that predates capturing
      // it (an upgrade path), not just a first-ever discovery.
      if (!stored || (stored.mac && stored.addressType != null)) return;
      await saveBoardCredentials({ ...stored, mac: event.address, addressType: event.addressType });
      logEvent('board-link', 'learned the board address — later reconnects can skip scanning', {
        devId,
        address: event.address,
        addressType: event.addressType,
      });
    })();
  });
  const stepSub = addDirectListener('onDirectStep', (event) => {
    if (event.devId !== devId) return;
    logEvent('board-link', event.message);
  });
  listenerCleanup.set(devId, [statusSub, dpUpdateSub, stepSub, addressSub]);

  void (async () => {
    if (isNaveeDevId(devId)) {
      await connectNaveeSession(devId);
      return;
    }
    const credentials = await loadBoardCredentials(devId);
    if (registeredDevId !== devId) return;
    if (!credentials) {
      // Keys live only in secure storage, written at direct-path pairing. A missing
      // record means the user hasn't signed in on this path yet (or cleared storage) —
      // say so rather than spinning on a search that can never succeed.
      logEvent('board-link', 'direct mode selected but no stored board keys — connect your board via Tuya sign-in', { devId });
      setState({ searchingTimeout: true });
      return;
    }
    // Ask before the first scan, not after. Android 12+ returns an empty scan almost
    // instantly without BLUETOOTH_SCAN, which is indistinguishable from a board that
    // is switched off, so a missing prompt looks like broken hardware.
    if (!(await ensureBlePermissions())) {
      if (registeredDevId !== devId) return;
      setState({ searchingTimeout: true, permissionDenied: true });
      return;
    }
    if (registeredDevId !== devId) return;
    setState({ permissionDenied: false });
    // connectDirect is idempotent per devId in the native module.
    BoardBleNative.connectDirect(
      devId,
      credentials.uuid,
      credentials.mac,
      credentials.localKey,
      credentials.secKey,
      credentials.addressType,
    );
  })();
}

/** The NAVEE half of registerDirectSession: same permission gate, NAVEE credentials. */
async function connectNaveeSession(devId: string): Promise<void> {
  const credentials = await loadNaveeCredentials(devId);
  if (registeredDevId !== devId) return;
  if (!credentials) {
    logEvent('board-link', 'NAVEE scooter selected but no stored account id — pair it again via NAVEE sign-in', { devId });
    setState({ searchingTimeout: true });
    return;
  }
  if (!(await ensureBlePermissions())) {
    if (registeredDevId !== devId) return;
    setState({ searchingTimeout: true, permissionDenied: true });
    return;
  }
  if (registeredDevId !== devId) return;
  setState({ permissionDenied: false });
  NaveeBleNative.connectDirect(
    devId,
    credentials.cloudMac,
    credentials.address,
    credentials.addressType,
    credentials.accountId,
    credentials.bindFlag,
  );
}

function startSearchTimeout(devId: string): void {
  if (searchTimeout) clearTimeout(searchTimeout);
  setState({ searchingTimeout: false });
  searchTimeout = setTimeout(() => {
    if (registeredDevId === devId && state.online !== true) setState({ searchingTimeout: true });
    searchTimeout = null;
  }, SEARCH_TIMEOUT_MS);
}

/** Self-rescheduling reconnect nudge: while this devId is registered but not
 * confirmed online, re-issue connectDevice on RECONNECT_RETRY_MS so a board that
 * returns after a power-cycle / out-of-range / sleep-wake is re-requested even if the
 * native poll's cached-online read never flips on its own. Stops the moment the board
 * confirms online (a status event or a live DP push), and is torn down on
 * teardownRegisteredDevice so a forgotten/switched device never keeps nudging. */

// Every caller of the four functions below (board-config.tsx's confirmSave, the
// pairing card's usePendingSettingsCount) only ever runs once that device's BLE
// session is already registered — same assumption the pre-multi-device code made
// implicitly by having only one possible device at all. No-ops (rather than
// throwing) if called with nothing registered, since that's not reachable from
// real UI today but isn't worth a hard crash if it ever were — logged, though: a
// silent no-op here would otherwise look identical to "saved successfully" from
// the caller's side, so if this assumption is ever wrong in practice, the debug
// log is what would actually reveal it.
async function hydratePendingSettings(): Promise<void> {
  const devId = await pendingSettingsDevId();
  if (!devId) return;
  await migrateLegacyKey(LEGACY_PENDING_SETTINGS_KEY, pendingSettingsKeyFor(devId));
  if (hydratePendingPromise) return hydratePendingPromise;
  hydratePendingPromise = (async () => {
    const raw = await AsyncStorage.getItem(pendingSettingsKeyFor(devId));
    if (!raw) return;
    try {
      const pending = JSON.parse(raw);
      if (pending && Object.keys(pending).length > 0) state = { ...state, pendingSettings: pending };
      notify();
    } catch {
      // Corrupt cache — ignore, nothing recoverable to retry from a bad blob.
    }
  })();
  return hydratePendingPromise;
}

export async function ensurePendingSettingsHydrated(): Promise<void> {
  await hydratePendingSettings();
}

/**
 * Applies everything queued right now, rather than waiting for the board to come back
 * on its own. Reconnects first when the board is away, since the flush is driven by the
 * connection transition. Returns how many were applied.
 */
export async function syncPendingSettingsNow(): Promise<number> {
  await hydratePendingSettings();
  const before = Object.keys(state.pendingSettings).length;
  if (before === 0) return 0;
  if (!isBoardTrulyConnected(registeredDevId)) {
    logEvent('board-settings-sync', 'sync requested while the board is away — reconnecting first');
    return 0;
  }
  await flushPendingSettings(registeredDevId ?? '');
  return before - Object.keys(state.pendingSettings).length;
}

export function getPendingSettings(): Record<string, BoardSettingValue> {
  return state.pendingSettings;
}

/** Called when a save fails because the board is offline — persists so it survives a restart and applies automatically on reconnect. */
export async function queuePendingSetting(dpId: string, value: BoardSettingValue): Promise<void> {
  const devId = await pendingSettingsDevId();
  if (!devId) {
    logEvent('board-settings-sync', `queuePendingSetting(dp${dpId}) has no device to queue against — dropped`);
    return;
  }
  const next = { ...state.pendingSettings, [dpId]: value };
  setState({ pendingSettings: next });
  await AsyncStorage.setItem(pendingSettingsKeyFor(devId), JSON.stringify(next));
}

async function clearPendingSetting(dpId: string): Promise<void> {
  const devId = await pendingSettingsDevId();
  if (!devId) return;
  const next = { ...state.pendingSettings };
  delete next[dpId];
  setState({ pendingSettings: next });
  await AsyncStorage.setItem(pendingSettingsKeyFor(devId), JSON.stringify(next));
}

// Firmware-settle workaround, shared by every per-DP write loop (this module's
// flushPendingSettings and board-config.tsx's confirmSave): the board's own
// processing of a DP write can still be in flight when the BLE-level write
// resolves, so a second write landing right after can get silently dropped.
// writeBoardSetting below is a single-DP function, so it's the *caller*'s job to
// wait this long between iterations of its own loop — not this constant's job.
export const DP_WRITE_SETTLE_MS = 400;

/** Single-DP write with the offline-queue policy shared by board-config.tsx's
 * confirmSave and flushPendingSettings below — used to be duplicated in both
 * places. Always attempts the real write first; only queues if it fails AND the
 * board is genuinely offline (a failure while still usable is a real error, not
 * a queue-and-retry case). Resolves 'saved' | 'queued'; rethrows on a genuine
 * failure so the caller's own error handling still applies. */
/**
 * Native failure codes that mean "the board never got this", as opposed to "the board
 * got it and said no". Only the former is queueable: re-applying a value the board
 * actively refused would retry it on every reconnect, forever.
 */
const QUEUEABLE_WRITE_CODES = new Set(['NOT_CONNECTED', 'NO_SESSION', 'NO_RESPONSE']);

function writeFailureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  // Older messages carried the class as a prefix rather than a code.
  const message = err instanceof Error ? err.message : String(err);
  return message.split(':')[0]?.trim() ?? 'UNKNOWN';
}

/**
 * Whether the native client actually holds a live session, regardless of what the JS
 * session state believes.
 *
 * The two can disagree: JS learns about connections from events, and anything that
 * misses one — a listener attached after the fact, a session adopted from the
 * background service, a transition dropped while the bridge was busy — leaves JS
 * showing a board that is genuinely connected as offline. Reconciling matters most on
 * the write path, where believing the board is away means queueing a change that could
 * have been applied immediately.
 */
export function isBoardTrulyConnected(devId: string | null): boolean {
  if (!devId) return false;
  try {
    return directIsConnected(devId);
  } catch {
    return false;
  }
}

/** Pulls JS session state back in line with the native client. */
export function reconcileConnectionState(): void {
  if (!registeredDevId) return;

  // A denial leaves the device registered but never connected, and ensureRegistered
  // early-returns on an already-registered devId — so without this the board stays
  // unreachable for the rest of the process even after the rider grants the permission
  // in system settings. Foreground return is exactly when they come back from doing it.
  if (state.permissionDenied) {
    const devId = registeredDevId;
    void (async () => {
      if (!(await hasBlePermissions())) return;
      if (registeredDevId !== devId) return;
      logEvent('board-link', 'Bluetooth permission granted since last try — reconnecting');
      teardownRegisteredDevice();
      ensureRegistered(devId);
    })();
    return;
  }

  // A plain connected/not-connected boolean can't tell "genuinely offline" from "still
  // scanning/connecting/handshaking" — reconciling against the latter is what tore a
  // fresh handshake back down ~150ms after it actually succeeded. Only settled phases are safe to reconcile
  // against; a mid-flight phase means native hasn't decided anything yet, so this run
  // simply no-ops and leaves the next connection/step event to update state normally.
  const phase = boardConnectionPhase(registeredDevId);
  if (phase !== 'connected' && phase !== 'backoff' && phase !== 'idle') return;
  const native = phase === 'connected';
  if (native === (state.online === true)) return;
  logEvent('board-link', `connection state out of sync — native says ${native ? 'connected' : phase}`);
  setState({ online: native, searchingTimeout: native ? false : state.searchingTimeout });
  emitBleConnectionTransition({ type: native ? 'connected' : 'disconnected', devId: registeredDevId });
}

/** The native client's own view of what it's doing right now for this devId, or null if
 * nothing is registered. See BoardBleClient.ConnectionPhase's doc comment (native side)
 * for why reconcileConnectionState needs this instead of a plain boolean. */
function boardConnectionPhase(devId: string | null): string | null {
  if (!devId) return null;
  try {
    return directConnectionPhase(devId);
  } catch {
    return null;
  }
}

/** The shared success path every write site below wants: the actual BLE write, the log
 * line, and clearing a stale queued value so it can't shadow the fresh one — a dpId can
 * already be queued from an earlier failure, and the settings screen prefers a queued
 * value over the live dp (see NaveeSettingsScreen.tsx's valueOf), so leaving it in place
 * after a later successful write makes re-selecting the board's real value look like a
 * no-op tap. Throws whatever writeBleDp throws; callers classify the failure. */
async function attemptWrite(dpId: string, value: BoardSettingValue, label = 'saved to the board'): Promise<void> {
  await writeBleDp(dpId, value);
  logEvent('board-settings', `dp${dpId}: ${label}`, { value });
  await clearPendingSetting(dpId);
}

export async function writeBoardSetting(dpId: string, value: BoardSettingValue): Promise<'saved' | 'queued'> {
  // Native truth first: queueing a change for a board that is actually connected is
  // the worse failure, since the rider is told it was deferred when it could have been
  // written straight away.
  if (isBoardTrulyConnected(registeredDevId)) {
    try {
      await attemptWrite(dpId, value);
      return 'saved';
    } catch (err) {
      const code = writeFailureCode(err);
      if (!QUEUEABLE_WRITE_CODES.has(code)) {
        logEvent('board-settings', `dp${dpId}: write failed (${code})`, {
          value,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      // NO_RESPONSE on a connection the session itself believes is live is usually a
      // single dropped notification, not a real disconnect — worth one immediate retry
      // before queueing for a reconnect that, on a genuinely still-connected board,
      // might not come for a while.
      if (code === 'NO_RESPONSE' && isBoardTrulyConnected(registeredDevId)) {
        try {
          await attemptWrite(dpId, value, 'saved to the board (after one retry)');
          return 'saved';
        } catch (retryErr) {
          const retryCode = writeFailureCode(retryErr);
          if (!QUEUEABLE_WRITE_CODES.has(retryCode)) {
            logEvent('board-settings', `dp${dpId}: retry failed (${retryCode})`, {
              value,
              message: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
            throw retryErr;
          }
        }
      }
      logEvent('board-settings', `dp${dpId}: write did not reach the board (${code}), queued for reconnect`, { value });
      await queuePendingSetting(dpId, value);
      return 'queued';
    }
  }

  const usability = getBoardUsability();
  // Queue without touching the wire when the board is known to be away. Attempting it
  // anyway costs the rider an 8s response timeout per datapoint before telling them
  // what the app already knew. 'charging' still writes — the board is connected.
  if (usability === 'offline' || usability === 'connecting' || usability === 'unpaired') {
    logEvent('board-settings', `dp${dpId}: board is ${usability}, queued without attempting the write`, { value });
    await queuePendingSetting(dpId, value);
    return 'queued';
  }
  try {
    await attemptWrite(dpId, value);
    return 'saved';
  } catch (err) {
    const code = writeFailureCode(err);
    const message = err instanceof Error ? err.message : String(err);
    // Classify on what the write actually reported, not on the session's own idea of
    // whether the board is reachable: the session can still read 'usable' for a board
    // that dropped moments ago, and throwing there strands a change the rider made
    // instead of queueing it.
    if (QUEUEABLE_WRITE_CODES.has(code)) {
      logEvent('board-settings', `dp${dpId}: write did not reach the board (${code}), queued for reconnect`, { value, message });
      await queuePendingSetting(dpId, value);
      return 'queued';
    }
    logEvent('board-settings', `dp${dpId}: write failed (${code})`, { value, message });
    throw err;
  }
}

/** Applies every queued setting now the board is reachable. A dpId that fails stays queued for the next reconnect — no extra retry bookkeeping needed.
 * `devId` (the device that just reconnected, from the connection-transition event) is
 * NOT the write target here — `writeBoardSetting` → `writeBleDp` resolves the actual
 * target itself via `getPairedDeviceId()` (the persisted active device). This only stays
 * correct because every code path that changes `registeredDevId` also updates the
 * persisted active-device id at or before that point (see `setActiveDeviceId`/
 * `forgetPairedDevice`) — if a future multi-device change ever lets `registeredDevId`
 * and the persisted active device diverge mid-switch, this would flush to the wrong
 * board. Kept as a param for the caller's event-payload symmetry, not because it's used. */
async function flushPendingSettings(devId: string): Promise<void> {
  await hydratePendingSettings();
  const dpIds = Object.keys(state.pendingSettings);
  if (dpIds.length === 0) return;
  logEvent('board-settings-sync', `board back online — applying ${dpIds.length} pending setting(s)`, state.pendingSettings);
  for (const [index, dpId] of dpIds.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, DP_WRITE_SETTLE_MS));
    const value = state.pendingSettings[dpId];
    try {
      const outcome = await writeBoardSetting(dpId, value);
      if (outcome === 'saved') {
        await clearPendingSetting(dpId);
        logEvent('board-settings-sync', `applied pending dp${dpId}`, { value });
      } else {
        // writeBoardSetting re-checked live and found the board still not usable —
        // it already re-persisted the same value via queuePendingSetting, so this
        // is a no-op on state, just the same "still queued" log the old inline
        // catch block produced when publishDp itself threw in this situation.
        logEvent('board-settings-sync', `failed to apply pending dp${dpId}, left queued for next reconnect`, { value });
      }
    } catch (err) {
      logEvent('board-settings-sync', `failed to apply pending dp${dpId}, left queued for next reconnect`, {
        value,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Registered once at module scope, not called inline from the onDeviceStatusChanged
// listener above — flushPendingSettings stays private to this module (it reaches
// into `state.pendingSettings`/`clearPendingSetting` directly), so it self-subscribes
// to the connection-transition seam rather than moving out like haptics/sound did
// (see lib/bleConnectionFeedback.ts). Fire-and-forget, matching the original inline
// call's behavior — flushPendingSettings already catches per-dpId write failures
// internally and leaves them queued for next reconnect.
subscribeToBleConnectionTransitions((event) => {
  if (event.type === 'connected') flushPendingSettings(event.devId);
});

// Reads Tuya's local SDK schema directly (no Cloud API needed). May be empty on a cold start before the device syncs; retried by ensureSchemaLoaded below.
// The direct path has no cloud to sync from — its schema is compiled into the app (lib/boardDpSchema.ts), so it resolves immediately.
function fetchSchema(devId: string) {
  // Compiled in rather than fetched: there is no cloud to sync a schema from.
  setState({ schema: isNaveeDevId(devId) ? NAVEE_DP_SCHEMA : BOARD_DP_SCHEMA });
}

/** Retries a few times if schema comes back empty (device not synced yet). */
export function ensureSchemaLoaded(devId: string, attempt = 0): void {
  // Guard against a devId no longer the registered one (e.g. after a forget/re-pair).
  if (registeredDevId !== devId) return;
  if (state.schema && Object.keys(state.schema).length > 0) return;
  if (attempt >= 5) {
    logEvent('board-schema', 'gave up after 5 attempts — schema never populated locally');
    return;
  }
  fetchSchema(devId);
  if (!state.schema || Object.keys(state.schema).length === 0) {
    if (schemaRetryTimeout) clearTimeout(schemaRetryTimeout);
    schemaRetryTimeout = setTimeout(() => {
      schemaRetryTimeout = null;
      ensureSchemaLoaded(devId, attempt + 1);
    }, 1500);
  }
}

export function getCachedSchema(): Record<string, BoardDpSchema> | null {
  return state.schema;
}

/** Merges values from activation's response or a scan, so a fresh activation shows up immediately without waiting for the first live delta. */
export function mergeDps(partial: Record<string, unknown>): void {
  // Activation/scan values come from the board over the air, same as a dp push — they
  // count as live, unlike the disk cache hydrateDpsCache loads.
  setState({ dps: { ...(state.dps ?? {}), ...dropImplausibleDps(state.dps, partial) }, dpsLive: true });
}

export function getCachedDps(): Record<string, unknown> | null {
  return state.dps;
}

/** Reads a specific device's persisted dp cache directly from storage, regardless
 * of whether it's the currently-active device (only one device can have a *live*
 * BLE session at a time, but every paired device's last-known values are still on
 * disk). Returns null for a device that's never reported any data yet, same "no
 * data" meaning `state.dps` being null already has for the active device. */
export async function getCachedDpsForDevice(devId: string): Promise<Record<string, unknown> | null> {
  if (devId === registeredDevId) return state.dps; // the active device's cache is already in memory
  const raw = await AsyncStorage.getItem(dpCacheKeyFor(devId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getBleSessionState(): SessionState {
  return state;
}

/** Awaits the local persisted cache loading at least once, so a synchronous
 * getCachedDps() call right after app start doesn't miss a real value. `devId` is
 * explicit — this can run before any component has registered a live session
 * (e.g. a background snapshot read), so it can't rely on `registeredDevId`. */
export async function ensureDpsHydrated(devId: string): Promise<void> {
  await hydrateDpsCache(devId);
}

export function subscribeBleSession(devId: string, listener: (s: SessionState) => void): () => void {
  ensureRegistered(devId);
  hydrateDpsCache(devId);
  hydratePendingSettings();
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

/** Tears down whatever device is currently registered — native listeners,
 * search/retry timeouts, in-memory state — without touching either device's
 * persisted per-device caches. Shared by resetBleSession (forgetting the active
 * device), switchActiveBleDevice (moving to a different still-paired one), and the
 * rider-triggered retry, which re-registers the same device afterwards.
 *
 * Deliberately does NOT stop background reconnection any more. That used to run
 * unconditionally here, which meant every teardown — a device switch, a permission-
 * recovery re-register in reconcileConnectionState, retryBoardConnection's own
 * teardown-then-reregister — also stopped the board's background service and wiped its
 * natively stored credentials. If a
 * reconnect then happened with the phone locked, restarting that service from the
 * background is refused outright, so the board could end up connected with nothing
 * keeping the process alive for it. Background reconnection now only ever stops where
 * the rider actually meant to stop it — see stopBackgroundReconnectSafely's callers
 * (holdDisconnected, resetBleSession). */
export function teardownRegisteredDevice(): void {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = null;
  if (schemaRetryTimeout) clearTimeout(schemaRetryTimeout);
  schemaRetryTimeout = null;
  const devIdToUnregister = registeredDevId;
  // Unsubscribe before clearing state so no stale listener survives a forget/re-pair/switch.
  listenerCleanup.forEach((unsubs) => unsubs.forEach((unsub) => unsub()));
  listenerCleanup.clear();
  state = {
    paired: false,
    online: null,
    charging: null,
    searchingTimeout: false,
    dps: null,
    schema: null,
    pendingSettings: {},
    dpsLive: false,
    permissionDenied: false,
  };
  registeredDevId = null;
  hydratePromise = null;
  hydratePendingPromise = null;
  if (devIdToUnregister) {
    try {
      directDisconnect(devIdToUnregister);
    } catch {
      // Best-effort; the JS-side teardown above has already run.
    }
  }
}

/** Called on "Forget"/release so stale data from a no-longer-paired board doesn't
 * linger — also deletes that device's persisted caches, unlike a plain device
 * switch (which leaves them in place for when you switch back). Forgetting is one of
 * the few cases that should actually stop background reconnection (see
 * teardownRegisteredDevice's own comment). */
export function resetBleSession(): void {
  const devIdToForget = registeredDevId;
  teardownRegisteredDevice();
  stopBackgroundReconnectSafely();
  if (devIdToForget) {
    AsyncStorage.removeItem(dpCacheKeyFor(devIdToForget)).catch(() => {});
    AsyncStorage.removeItem(pendingSettingsKeyFor(devIdToForget)).catch(() => {});
  }
  // Legacy flat keys too, in case forget happens before either ever migrated (a
  // fresh-install edge case, but cheap to cover).
  AsyncStorage.removeItem(LEGACY_DP_CACHE_KEY).catch(() => {});
  AsyncStorage.removeItem(LEGACY_PENDING_SETTINGS_KEY).catch(() => {});
  notify();
}

/** Deletes a paired-but-not-currently-active device's persisted caches — the
 * "forget a board that isn't the one you're looking at right now" case, which has
 * no live session to tear down. */
export function clearDeviceCache(devId: string): void {
  if (devId === registeredDevId) return; // has a live session — resetBleSession handles that path
  AsyncStorage.removeItem(dpCacheKeyFor(devId)).catch(() => {});
  AsyncStorage.removeItem(pendingSettingsKeyFor(devId)).catch(() => {});
}

/** Moves the live session from whatever's currently registered to `devId` — same
 * per-device caches either device had before are left untouched, so switching back
 * later picks up right where it left off. No-ops if `devId` is already active. */
export function switchActiveBleDevice(devId: string): void {
  if (registeredDevId === devId) return;
  teardownRegisteredDevice();
  ensureRegistered(devId);
  hydrateDpsCache(devId);
  hydratePendingSettings();
  notify();
}
