import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import BoardBleNative from '@modules/board-ble/src/BoardBle';
import NaveeBleNative, { type NaveeAccountVehicle, type NaveeCaptcha, type NaveeScanResult } from '@modules/navee-ble/src/NaveeBle';
import {
  deleteNaveeCredentials,
  isNaveeDevId,
  loadNaveeCredentials,
  naveeDevId,
  saveNaveeCredentials,
} from '@/features/device/navee/credentials';
import { directQueryStatus, directReconnectNow } from '@/features/device/deviceLink/transport';
import { naveeSettingForWrite } from '@/features/device/navee/settings';
import { loadBoardCredentials, saveBoardCredentials, deleteBoardCredentials } from '@/features/device/boardCredentials';
import { dpWriteType, toWireDpValue, type BoardDpSchema } from '@/features/device/boardDpSchema';
import { applyBackgroundSelfHeal } from '@/features/device/backgroundSelfHeal';
import { DEFAULT_BRAND, devicesApi, type BoardSnapshot } from '@/lib/api';
import { logEvent } from '@/lib/log';
import { ensureBlePermissions } from '@/features/device/deviceLink/permissions';
import { migrateOnce } from '@/lib/storageMigration';
import { GLOBAL_DP } from '@/features/device/boardDpLabels';
import { decodeMode } from '@/lib/mode';
import { decodeScaled } from '@/features/device/boardValue';
import {
  clearDeviceCache,
  ensureDpsHydrated,
  ensurePendingSettingsHydrated,
  ensureSchemaLoaded,
  getCachedDps,
  getCachedDpsForDevice,
  getCachedSchema,
  getBleSessionState,
  getPendingSettings,
  registerPairedDevice,
  resetBleSession,
  subscribeBleSession,
  switchActiveBleDevice,
  teardownRegisteredDevice,
  holdDisconnected,
  isManuallyDisconnected,
  clearDisconnectHold,
  type SessionState,
  type BoardSettingValue,
} from '@/features/device/deviceLink/session';

// Forces hooks mounted before pairing (e.g. Dashboard's indicator) to re-subscribe once a device becomes paired, since their mount effect already ran and won't re-fire on its own.
const pairedListeners = new Set<() => void>();

function notifyDevicePaired(): void {
  pairedListeners.forEach((l) => l());
}

/** Same signal as usePairedDeviceEpoch, for a non-React caller (tripRecorder.ts's
 * app-lifetime BLE speed subscription) that needs to know when a device becomes paired
 * after having already started up with none — e.g. a fresh install, first pairing.
 * React consumers should use usePairedDeviceEpoch instead. */
export function onDevicePaired(listener: () => void): () => void {
  pairedListeners.add(listener);
  return () => pairedListeners.delete(listener);
}

/** Bumps every time the paired-device list changes (pair/forget/switch) — exported
 * so other modules (e.g. deviceFilter.ts's trip filter) can re-read the paired list
 * reactively too, instead of only on their own mount. */
export function usePairedDeviceEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const listener = () => setEpoch((e) => e + 1);
    pairedListeners.add(listener);
    return () => {
      pairedListeners.delete(listener);
    };
  }, []);
  return epoch;
}

/** The active paired device's brand ('tynee', 'navee', ...), or null while nothing's
 * paired. The Tuya-DP-based quick controls (lock/headlight/cruise/ride-mode) only mean
 * anything for a Tynee board's product schema — gating on this, rather than assuming
 * every paired device speaks the same DPs, is what keeps those controls from showing
 * up for a future non-Tynee brand that has no dp1/dp8/dp13/dp14 at all. */
export function useActiveDeviceBrand(): string | null {
  const [brand, setBrand] = useState<string | null>(null);
  const pairedEpoch = usePairedDeviceEpoch();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const activeId = await getActiveDeviceId();
      if (!activeId) {
        if (!cancelled) setBrand(null);
        return;
      }
      const devices = await getPairedDevices();
      if (!cancelled) setBrand(devices.find((d) => d.devId === activeId)?.brand ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [pairedEpoch]);

  return brand;
}

export type { BoardDpSchema };

// Thrown when Direct BLE is selected but nothing's paired/linked. Mirrors ApiNotConfiguredError so the Dashboard's existing error UI handles it.
export class BleNotConfiguredError extends Error {
  constructor(reason?: string) {
    // Deliberately noun-free: this module is imported almost everywhere, and reaching
    // the rider's noun means importing lib/auth, whose module-level session wiring has
    // no business being pulled in by an error string.
    super(reason ?? 'No board is paired yet. Pair one in Settings > Connection.');
    this.name = 'BleNotConfiguredError';
  }
}

// More than one board can be paired; exactly one is "active" (the one board-config,
// dashboard telemetry, and settings sync all read/write).
export type PairedDevice = { devId: string; uuid: string; name: string | null; brand: string };

const PAIRED_DEVICES_KEY = 'tynee.pairedBleDevices';
const ACTIVE_DEVICE_KEY = 'tynee.activeBleDeviceId';
// Pre-multi-device single-device keys — migrated into a one-item PAIRED_DEVICES_KEY
// list (set active) the first time getPairedDevices()/getActiveDeviceId() runs
// after upgrading, then removed. Preserves an existing install's real pairing.
const LEGACY_DEVICE_ID_KEY = 'tynee.pairedBleDeviceId';
const LEGACY_DEVICE_UUID_KEY = 'tynee.pairedBleDeviceUuid';
const LEGACY_DEVICE_NAME_KEY = 'tynee.pairedBleDeviceName';

// Shares migrateOnce's already-migrated guard with deviceLink/session.ts's legacy
// dp-cache/pending-settings migrations instead of each re-implementing the same
// check.
function migrateLegacySingleDevice(): Promise<void> {
  return migrateOnce(PAIRED_DEVICES_KEY, async () => {
    const [devId, uuid, name] = await Promise.all([
      AsyncStorage.getItem(LEGACY_DEVICE_ID_KEY),
      AsyncStorage.getItem(LEGACY_DEVICE_UUID_KEY),
      AsyncStorage.getItem(LEGACY_DEVICE_NAME_KEY),
    ]);
    if (!devId || !uuid) return; // nothing was paired before upgrading
    // The Tuya BLE path only ever pairs Tynee boards, so a pre-multibrand single
    // device is accurately defaulted to the Tynee brand (DEFAULT_BRAND), not guessed.
    const devices: PairedDevice[] = [{ devId, uuid, name, brand: DEFAULT_BRAND }];
    await AsyncStorage.setItem(PAIRED_DEVICES_KEY, JSON.stringify(devices));
    await AsyncStorage.setItem(ACTIVE_DEVICE_KEY, devId);
    await AsyncStorage.removeMany([LEGACY_DEVICE_ID_KEY, LEGACY_DEVICE_UUID_KEY, LEGACY_DEVICE_NAME_KEY]);
  });
}

export async function getPairedDevices(): Promise<PairedDevice[]> {
  await migrateLegacySingleDevice();
  const raw = await AsyncStorage.getItem(PAIRED_DEVICES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A device paired before `brand` existed is stored without the field; default
    // it to DEFAULT_BRAND (the Tuya BLE path only ever pairs Tynee boards, so all
    // pre-existing boards are Tynee) so every returned PairedDevice carries a brand
    // without a one-time storage migration.
    return parsed.map((d) => ({ devId: d.devId, uuid: d.uuid, name: d.name ?? null, brand: d.brand ?? DEFAULT_BRAND }));
  } catch {
    return [];
  }
}

async function setPairedDevices(devices: PairedDevice[]): Promise<void> {
  if (devices.length === 0) await AsyncStorage.removeItem(PAIRED_DEVICES_KEY);
  else await AsyncStorage.setItem(PAIRED_DEVICES_KEY, JSON.stringify(devices));
}

/** Only one board can have a *live* BLE session at a time, but every paired
 * device's last-known battery is still on disk (getCachedDpsForDevice), so this
 * gives an at-a-glance summary of every paired board without needing to switch
 * active device just to check one. */
export type DeviceSummary = { devId: string; name: string | null; batteryPct: number | null; hasData: boolean };

export async function getAllDeviceSummaries(): Promise<DeviceSummary[]> {
  const devices = await getPairedDevices();
  return Promise.all(
    devices.map(async (d): Promise<DeviceSummary> => {
      const dps = await getCachedDpsForDevice(d.devId);
      const battery = dps?.[GLOBAL_DP.battery];
      return { devId: d.devId, name: d.name, batteryPct: typeof battery === 'number' ? battery : null, hasData: dps != null };
    }),
  );
}

export async function getActiveDeviceId(): Promise<string | null> {
  await migrateLegacySingleDevice();
  return AsyncStorage.getItem(ACTIVE_DEVICE_KEY);
}

async function setActiveDeviceIdRaw(devId: string | null): Promise<void> {
  if (devId) await AsyncStorage.setItem(ACTIVE_DEVICE_KEY, devId);
  else await AsyncStorage.removeItem(ACTIVE_DEVICE_KEY);
}

/** Switches which paired device the rest of the app reads/writes — board-config,
 * dashboard telemetry, settings sync all follow whichever device is active. No-op
 * if `devId` isn't actually a currently-paired device. */
export async function setActiveDeviceId(devId: string): Promise<void> {
  const devices = await getPairedDevices();
  if (!devices.some((d) => d.devId === devId)) return;
  await setActiveDeviceIdRaw(devId);
  switchActiveBleDevice(devId);
  notifyDevicePaired();
}

/** Convenience alias for "the active device's id" — most existing call sites
 * (writeBleDp, ensureBleConnected, getBleSnapshot) mean "whichever board is
 * currently active", not a specific one, same as before multi-device existed. */
export async function getPairedDeviceId(): Promise<string | null> {
  return getActiveDeviceId();
}

/** Local cache of the device's name — not written to the board or Tuya's servers
 * (the SDK has no such write), but backed by the account's own
 * DeviceSetting.deviceName on the backend (see renamePairedDevice/resolveDeviceName),
 * not just this phone's storage. Defaults to the active device when `devId` is
 * omitted. Reads the local cache only — for the fast, offline-safe path every
 * getBleSnapshot() poll needs; resolveDeviceName is what falls through to the
 * backend when this is empty. */
export async function getPairedDeviceName(devId?: string): Promise<string | null> {
  const targetId = devId ?? (await getActiveDeviceId());
  if (!targetId) return null;
  const devices = await getPairedDevices();
  return devices.find((d) => d.devId === targetId)?.name ?? null;
}

/** One device name per device across the whole ecosystem: this writes the SAME
 * backend field (DeviceSetting.deviceName) that EstimateSettingsCard's "Friendly
 * device name" field already edits, instead of a phone-local-only value — so a
 * reinstall, or pairing the same board from another phone, recovers the rider's
 * chosen name via resolveDeviceName's backend fallback instead of resetting to the
 * raw Tuya SDK/product string. The local cache updates first (instant UI feedback,
 * and the typed name survives even if the backend write below fails — offline, a
 * server hiccup); the backend write is best-effort, same as every other
 * background-sync write in this app, and can simply be retried by renaming again. */
export async function renamePairedDevice(name: string, devId?: string): Promise<void> {
  const targetId = devId ?? (await getActiveDeviceId());
  if (!targetId) return;
  const trimmed = name.trim();
  const finalName = trimmed || null;
  const devices = await getPairedDevices();
  await setPairedDevices(devices.map((d) => (d.devId === targetId ? { ...d, name: finalName } : d)));

  try {
    // PUT /devices/{id}/settings is a full replace (backend/app/services/devices.py's
    // generic upsert), not a merge patch — every other field must be sent back
    // unchanged or it reverts to null, wiping out weight/capacity/spec-sheet values
    // EstimateSettingsCard already saved for this board.
    const current = await devicesApi.getDeviceSettings(targetId);
    await devicesApi.putDeviceSettings(targetId, {
      deviceName: finalName,
      batteryCapacityWh: current?.batteryCapacityWh ?? null,
      boardWeightKg: current?.boardWeightKg ?? null,
      cellConfig: current?.cellConfig ?? null,
      packNominalVoltageV: current?.packNominalVoltageV ?? null,
      motorPowerW: current?.motorPowerW ?? null,
      escModel: current?.escModel ?? null,
      wheelType: current?.wheelType ?? null,
      truckSizeInches: current?.truckSizeInches ?? null,
      brand: current?.brand ?? null,
      wheelDiameterMm: current?.wheelDiameterMm ?? null,
      driveType: current?.driveType ?? null,
    });
  } catch (err) {
    logEvent('board-name', 'backend deviceName save failed — kept locally, will retry on next rename', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Removes one paired device (default: the active one) from the list. If the
 * forgotten device was active, falls back to another remaining paired device (or
 * none) and switches the live session there; otherwise there's no live session to
 * tear down, just that device's own leftover caches. */
export async function forgetPairedDevice(devId?: string): Promise<void> {
  const devices = await getPairedDevices();
  const activeId = await getActiveDeviceId();
  const targetId = devId ?? activeId;
  if (!targetId) return;

  await setPairedDevices(devices.filter((d) => d.devId !== targetId));
  // The direct path's key material is per-device secret storage — a forgotten board's
  // keys must go with the pairing record, or secure storage leaks credentials for a
  // board this app no longer knows.
  await deleteBoardCredentials(targetId);
  await deleteNaveeCredentials(targetId);

  if (targetId === activeId) {
    resetBleSession(); // tears down the live session and deletes targetId's own caches
    const nextActive = devices.find((d) => d.devId !== targetId)?.devId ?? null;
    await setActiveDeviceIdRaw(nextActive);
    if (nextActive) switchActiveBleDevice(nextActive);
  } else {
    clearDeviceCache(targetId);
  }
  notifyDevicePaired();
  // Covers the "forgot the only paired device, nothing to fall back to" case —
  // switchActiveBleDevice's own ensureRegistered call already re-applies this when a
  // fallback device exists, but that path is skipped when nextActive is null, which
  // would otherwise leave the JS self-heal task (and its "tracking your location"
  // notification) registered forever with no board to self-heal for.
  void applyBackgroundSelfHeal();
}

/** Falls back to the backend's saved DeviceSetting.deviceName (the durable,
 * account-wide source of truth — see renamePairedDevice), then the SDK's raw
 * product string, when the local AsyncStorage cache has no name yet — e.g. a fresh
 * install, or this board freshly paired on a different phone. Either way,
 * backfills the local cache so this only ever costs one backend round trip, not
 * one per getBleSnapshot() poll: every call after the first hits the cached
 * value at the top of this function's caller (getPairedDeviceName) and returns
 * immediately. */
export async function resolveDeviceName(devId: string): Promise<string | null> {
  const cached = await getPairedDeviceName(devId);
  if (cached) return cached;
  const fromBackend = await devicesApi
    .getDeviceSettings(devId)
    .then((setting) => setting?.deviceName ?? null)
    .catch(() => null);
  const name = fromBackend;
  if (name) {
    const devices = await getPairedDevices();
    if (devices.some((d) => d.devId === devId)) await setPairedDevices(devices.map((d) => (d.devId === devId ? { ...d, name } : d)));
  }
  return name;
}

// dpId mapping confirmed against the device's real Tuya product schema (see lib/boardDpLabels.ts).
export async function getBleSnapshot(): Promise<BoardSnapshot> {
  const pairedDeviceId = await getPairedDeviceId();
  if (!pairedDeviceId) throw new BleNotConfiguredError();
  // Waits for the AsyncStorage read, so a synchronous read right after app start doesn't miss a real cached value.
  await ensureDpsHydrated(pairedDeviceId);
  const deviceName = await resolveDeviceName(pairedDeviceId);

  // The DP cache is only updated by live pushes, so it stays frozen at the
  // last-known values after a disconnect — the 2s dashboard auto-refresh must
  // reflect the board actually being turned off, not just re-read stale cached DPs
  // forever. Consult the live session state instead: once the board is confirmed
  // offline, report online:false with null telemetry so the refresh (and the trip
  // recorder's snapshot) sees the disconnect instead of stale data.
  //
  // `session.online === false` alone isn't enough: online is null (not false) until
  // the first real status event or push lands this process, and dps can be fully
  // populated purely from the AsyncStorage-hydrated disk cache at app start — "days
  // old with no board in range," per widgetSync.ts's boardIsReporting(), which this
  // mirrors. Requiring session.dpsLive too closes the same gap here: without it, a
  // cold start with a previously-paired board that's now out of range briefly (or
  // indefinitely, if no status event ever arrives) reported online:true with stale
  // speed/battery/odometer values to both the live speedometer and the trip
  // recorder's own snapshot polling.
  const session = getBleSessionState();
  if (session.online !== true || !session.dpsLive) {
    return {
      online: false,
      deviceName,
      speedKmh: null,
      batteryPct: null,
      remoteBatteryPct: null,
      mileageOnceKm: null,
      mileageTotalKm: null,
      rideTimeOnceSec: null,
      voltageV: null,
      mode: null,
      headlightOn: null,
      cruiseOn: null,
      lockOn: null,
      unit: null,
    };
  }

  const dps = getCachedDps();

  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  // Paired but no first DP yet isn't an error — return an all-null snapshot for the existing "no data yet" UI to handle.
  if (!dps) {
    return {
      online: false,
      deviceName,
      speedKmh: null,
      batteryPct: null,
      remoteBatteryPct: null,
      mileageOnceKm: null,
      mileageTotalKm: null,
      rideTimeOnceSec: null,
      voltageV: null,
      mode: null,
      headlightOn: null,
      cruiseOn: null,
      lockOn: null,
      unit: null,
    };
  }

  const scaled = (dpId: string): number | null => {
    const v = num(dps[dpId]);
    return v != null ? decodeScaled(v, 1) : null;
  };
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const rawMode = str(dps['14']);
  // dp1's wire polarity is the opposite of its meaning: `true` reports unlocked,
  // `false` reports locked (see mobile/modules/board-ble/DATAPOINTS.md
  // and lib/boardQuickControls.ts's useLockControl, which applies the same inversion).
  const rawLock = bool(dps['1']);

  return {
    online: true, // confirmed by the guard above: online === true and the dp cache is live, not just hydrated from disk
    deviceName,
    speedKmh: scaled('2'),
    batteryPct: num(dps['3']),
    remoteBatteryPct: num(dps['102']),
    mileageOnceKm: scaled('5'),
    mileageTotalKm: scaled('12'),
    rideTimeOnceSec: num(dps['6']),
    voltageV: scaled('20'),
    mode: rawMode ? decodeMode(rawMode) : null,
    headlightOn: bool(dps['8']),
    cruiseOn: bool(dps['13']),
    lockOn: rawLock == null ? null : !rawLock,
    unit: str(dps['11']),
  };
}

/** "Range by mode" needs SOME battery/voltage reading to turn a per-mode km-per-%
 * ratio into an actual km number — while the board is disconnected getBleSnapshot()
 * deliberately reports null telemetry (so the live dashboard speedometer reflects a
 * real disconnect instead of stale DPs; see getBleSnapshot's own comment) rather
 * than the DP cache's frozen last reading. Range-by-mode wants the opposite of that
 * dashboard behavior: showing yesterday's
 * battery level beats showing nothing. This reads the same persisted DP cache
 * directly, bypassing the online gate, so a caller that explicitly wants "last known,
 * even if stale" (unlike the live dashboard) can have it. Returns nulls if the board
 * has never reported in at all — same "no data yet" meaning as getBleSnapshot's own
 * no-dps branch. */
export function getLastKnownBatteryTelemetry(): { batteryPct: number | null; voltageV: number | null } {
  const dps = getCachedDps();
  if (!dps) return { batteryPct: null, voltageV: null };
  const rawVoltage = dps['20'];
  return {
    batteryPct: typeof dps['3'] === 'number' ? dps['3'] : null,
    voltageV: typeof rawVoltage === 'number' ? decodeScaled(rawVoltage, 1) : null,
  };
}

// ---------------------------------------------------------------------------
// SDK-free direct path: Tuya-account sign-in → pick the board → store its keys.
// The password is a call parameter only; the keys land in expo-secure-store
// (lib/boardCredentials.ts) and the native client holds them in memory only.
// ---------------------------------------------------------------------------

export type DirectAccountDevice = {
  devId: string;
  uuid: string | null;
  name: string | null;
  productId: string | null;
};

/** Signs in to the Tuya account that owns the board, using the same mobile API the Tuya Smart app uses. Email accounts only. */
export async function directSignIn(email: string, password: string, countryCode: string): Promise<{ uid: string }> {
  return BoardBleNative.signIn(email, password, countryCode);
}

/**
 * Boards in the signed-in account — a plain Tuya API call, no Bluetooth involved.
 *
 * This used to also run an 8s Bluetooth scan here, purely to badge whichever device was
 * advertising nearby as a "seen nearby" hint, and asked for the Bluetooth permission to
 * do it — at the point pairing means nothing more than "fetch this board's keys from the
 * Tuya account and store them," which needs no Bluetooth at all. The rider is asked for
 * Bluetooth only once pairing is actually done and the app needs to connect (see
 * registerDirectBoard, reached via directPairDevice), which is also the first point a
 * scan can find anything worth badging as "nearby" instead of guessing blind.
 */
export async function directListDevices(): Promise<DirectAccountDevice[]> {
  const devices = await BoardBleNative.listDevices();
  return [...devices].sort((a, b) => (a.name ?? a.devId).localeCompare(b.name ?? b.devId));
}

/**
 * Re-fetches an already-paired board's key material from the Tuya account and updates
 * what is stored, without touching the pairing itself.
 *
 * fetchKeys was previously reachable only by pairing, and the Tuya session lives in
 * native memory that a restart clears — so the only way to refresh anything from the
 * account was to forget the board and pair it again. That is a lot of ceremony for
 * re-reading data the account already has, and it throws away the local record
 * (queued settings, cached values) to do it.
 *
 * Keeps the learned Bluetooth address: that is discovered by scanning, not supplied by
 * the account, and losing it would send reconnects back to the timer-driven scan.
 */
export async function refreshBoardFromAccount(devId: string): Promise<{ schemaFromAccount: boolean }> {
  const keys = await BoardBleNative.fetchKeys(devId);
  if (!keys.localKey) throw new Error('Tuya returned no key for this board. It may have been removed in the Tuya Smart app.');
  const existing = await loadBoardCredentials(devId);
  await saveBoardCredentials({
    devId: keys.devId,
    uuid: keys.uuid ?? existing?.uuid ?? null,
    mac: existing?.mac ?? null,
    localKey: keys.localKey,
    secKey: keys.secKey,
    productId: keys.productId ?? existing?.productId ?? null,
    name: existing?.name ?? null,
  });
  logEvent('board-link', 'refreshed board keys from the Tuya account', {
    devId: keys.devId,
    secKeyPresent: keys.secKey != null,
    localKeyChanged: existing?.localKey != null && existing.localKey !== keys.localKey,
    schemaFromAccount: keys.schemaJson != null,
    schemaChars: keys.schemaJson?.length ?? 0,
    keptKnownAddress: existing?.mac != null,
  });
  return { schemaFromAccount: keys.schemaJson != null };
}

/** Fetches the chosen board's keys, stores them in secure storage, and pairs it as the active device. */
export async function directPairDevice(device: { devId: string; uuid: string | null; name: string | null }): Promise<PairedDevice> {
  const keys = await BoardBleNative.fetchKeys(device.devId);
  if (!keys.localKey) throw new Error('Tuya returned no key for this board. Check it is added in the Tuya Smart app.');
  await saveBoardCredentials({
    devId: keys.devId,
    uuid: keys.uuid ?? device.uuid,
    mac: null,
    localKey: keys.localKey,
    secKey: keys.secKey,
    productId: keys.productId,
    name: device.name,
  });
  // Whether the account gave us the board's own schema decides whether the ranges and
  // enum values shown are the board's or the ones compiled into this build, which have
  // been wrong for a real board before. Worth knowing per pairing, not guessing at.
  logEvent('board-link', 'stored board keys in secure storage', {
    devId: keys.devId,
    secKeyPresent: keys.secKey != null,
    schemaFromAccount: keys.schemaJson != null,
    schemaChars: keys.schemaJson?.length ?? 0,
  });

  return registerDirectBoard({ devId: keys.devId, uuid: keys.uuid ?? device.uuid, name: device.name });
}

/**
 * Records a board as paired and makes it active, without touching key material.
 *
 * Storing keys is not enough on its own: nothing registers a live session until a
 * board is in the paired list with an active id, so a board whose keys exist but
 * whose record does not simply sits there with no session and no logs. Split out of
 * directPairDevice so the SDK key-import bridge completes the same registration
 * instead of half of it.
 */
export async function registerDirectBoard(
  device: { devId: string; uuid: string | null; name: string | null },
  brand: string = DEFAULT_BRAND,
): Promise<PairedDevice> {
  const devices = await getPairedDevices();
  const existingName = devices.find((d) => d.devId === device.devId)?.name ?? device.name;
  const newEntry: PairedDevice = {
    devId: device.devId,
    // The uuid is the BLE-matching identity; fall back to the devId so the paired
    // record always has a non-empty identifier (BoardScanner matches by either).
    uuid: device.uuid ?? device.devId,
    name: existingName,
    brand,
  };
  await setPairedDevices([...devices.filter((d) => d.devId !== device.devId), newEntry]);
  await setActiveDeviceIdRaw(device.devId);
  switchActiveBleDevice(device.devId);
  notifyDevicePaired();
  logEvent('board-link', 'registered board as active', { devId: device.devId });
  return newEntry;
}

/** Clears the in-memory mobile-API session; stored keys stay so the board keeps connecting. */
/** Whether the native Tuya session is still alive. It is in-memory only, so this is
 * false after any app restart even though the board stays paired. */
export function isSignedInToTuya(): boolean {
  try {
    return BoardBleNative.isSignedInToTuya();
  } catch {
    return false;
  }
}

export function directSignOut(): void {
  BoardBleNative.signOut();
}

/** Deletes a device's stored keys — used by the direct path's "Forget", alongside the paired-record removal. */
export async function forgetDirectCredentials(devId: string): Promise<void> {
  await deleteBoardCredentials(devId);
}

// ---------------------------------------------------------------------------
// NAVEE: account sign-in → pick the scooter → store the account id its auth checks.
// Same shape as the Tuya path above; the password is a call parameter only.
// ---------------------------------------------------------------------------

export type { NaveeAccountVehicle, NaveeCaptcha, NaveeScanResult };

/** The image code NAVEE's login asks for. Fetch a fresh one for every attempt. */
export function naveeCaptcha(): Promise<NaveeCaptcha> {
  return NaveeBleNative.captcha();
}

export async function naveeSignIn(email: string, password: string, captchaCode: string, captchaUuid: string): Promise<{ userId: number }> {
  return NaveeBleNative.signIn(email, password, captchaCode, captchaUuid);
}

export async function naveeListVehicles(): Promise<NaveeAccountVehicle[]> {
  const vehicles = await NaveeBleNative.listVehicles();
  return [...vehicles].sort((a, b) => (a.name ?? a.mac).localeCompare(b.name ?? b.mac));
}

/**
 * Stores what the chosen scooter's auth needs and pairs it as the active device. A
 * scooter shared with this account authenticates as its owner (the official app's own
 * rule), otherwise as the signed-in account.
 */
export async function naveePairVehicle(vehicle: NaveeAccountVehicle): Promise<PairedDevice> {
  const ownId = NaveeBleNative.signedInUserId();
  const shared = vehicle.shareUserId > 0;
  const accountId = shared ? vehicle.shareUserId : ownId;
  if (!accountId) throw new Error('Sign in to NAVEE again. The session ended before the scooter could be paired.');
  const devId = naveeDevId(vehicle.mac);
  const existing = await loadNaveeCredentials(devId);
  await saveNaveeCredentials({
    devId,
    cloudMac: vehicle.mac,
    accountId,
    bindFlag: shared ? 1 : 0,
    address: existing?.address ?? null,
    addressType: existing?.addressType ?? null,
    productId: vehicle.productId,
    name: vehicle.name,
  });
  logEvent('board-link', 'stored NAVEE scooter credentials in secure storage', {
    devId,
    productId: vehicle.productId,
    shared,
  });
  return registerDirectBoard({ devId, uuid: devId, name: vehicle.name }, 'navee');
}

/**
 * Pairs a scooter found by a direct BLE scan instead of the account's vehicle list —
 * for when `getVehicle` comes back empty even though the scooter really is bound to
 * this account (seen live: NAVEE's own backend didn't reflect a scooter add right
 * away). The BLE auth only ever needs the signed-in account's own id and bindFlag 0
 * for a scooter this account owns outright; a scooter
 * shared with this account needs the owner's id from naveeListVehicles, which this
 * path doesn't have, so it isn't offered for a shared scooter.
 */
export async function naveePairScanned(result: NaveeScanResult): Promise<PairedDevice> {
  const accountId = NaveeBleNative.signedInUserId();
  if (!accountId) throw new Error('Sign in to NAVEE again. The session ended before the scooter could be paired.');
  const identifier = result.cloudMac ?? result.address;
  const devId = naveeDevId(identifier);
  await saveNaveeCredentials({
    devId,
    cloudMac: identifier,
    accountId,
    bindFlag: 0,
    address: result.address,
    addressType: result.addressType,
    productId: result.productId != null ? String(result.productId) : null,
    name: result.name,
  });
  logEvent('board-link', 'stored NAVEE scooter credentials from a BLE scan (no cloud vehicle record)', {
    devId,
    productId: result.productId,
  });
  return registerDirectBoard({ devId, uuid: devId, name: result.name }, 'navee');
}

export function isSignedInToNavee(): boolean {
  try {
    return NaveeBleNative.isSignedIn();
  } catch {
    return false;
  }
}

export function naveeSignOut(): void {
  NaveeBleNative.signOut();
}

/** Writes a single DP over the already-open BLE connection (never a batch, so every
 * write traces to one deliberate UI action). Throws BleNotConfiguredError if unpaired. */
export async function writeBleDp(dpId: string, value: boolean | number | string): Promise<void> {
  const devId = await getPairedDeviceId();
  if (!devId) throw new BleNotConfiguredError();
  // A NAVEE "dp" is a settings key (lib/navee/settings.ts); the native side owns the
  // command it maps to. Same error codes as the Tuya path, so the offline queue in
  // writeBoardSetting treats both brands alike.
  if (isNaveeDevId(devId)) {
    const setting = naveeSettingForWrite(dpId, value);
    await NaveeBleNative.writeSetting(devId, setting.key, setting.value);
    return;
  }
  // The wire needs the KLV type tag per write, and an enum's index rather than the
  // label the UI holds.
  const schema = getCachedSchema();
  await BoardBleNative.publishDpDirect(devId, dpId, dpWriteType(dpId, schema), toWireDpValue(dpId, value, schema));
}

/** Actively re-fetches the board's current values instead of waiting for its own next
 * scheduled push (otherwise values could go stale with no way to force a refresh
 * short of the board happening to push something on its own -- pull-to-refresh
 * didn't actually re-query the board either). Queries every dpId the board's own product
 * schema reports once it's synced, falling back to the app's known GLOBAL_DP set before
 * the schema loads. Results arrive the normal way, through the already-registered
 * onDpUpdate live-push listener, not from this call directly. No-op (not a thrown error)
 * if nothing's paired or the query fails -- this is a best-effort nudge (on-connect, and
 * a periodic poll while the app is foregrounded), not a user-facing action with its own
 * error state. */
export async function refreshDeviceStatus(): Promise<void> {
  const devId = await getPairedDeviceId();
  if (!devId) return;
  if (isNaveeDevId(devId)) {
    try {
      await directQueryStatus(devId);
    } catch (err) {
      logEvent('board-status', 'NAVEE status read failed', { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const schema = getCachedSchema();
  const dpIds =
    schema && Object.keys(schema).length > 0
      ? Object.keys(schema)
          .map(Number)
          .filter((n) => Number.isFinite(n))
      : Object.values(GLOBAL_DP).map(Number);
  if (dpIds.length === 0) return;
  try {
    // One opcode fetches the whole board state; values arrive via onDirectDpUpdate.
    await BoardBleNative.queryDpsDirect(devId);
  } catch (err) {
    logEvent('board-status', 'queryDeviceStatus failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Cheap, safe-to-call-anytime reconnect nudge — belt-and-suspenders for app-foreground
 * return (see BleReconnectGate in app/_layout.tsx) and for the trip recorder's own
 * periodic cadence (tripRecorder.ts), which depends on getBoardUsability() to gate
 * auto-start and needs a live session even if no BLE-consuming screen has ever mounted.
 *
 * Calling TuyaBleNative.connectDevice(devId) directly here, bypassing
 * tuyaBleSession's registerPairedDevice/ensureRegistered entirely, is a real trap: the native
 * link could come up genuinely connected while getBoardUsability() stayed stuck reporting
 * 'unpaired' for the whole process lifetime, since nothing had ever populated the shared
 * session state (that only happens via a Dashboard/Settings mount, or here). A rider who
 * starts a ride without ever having opened past a signed-out/login screen this process run
 * (e.g. an expired session token flips useSession() to signed-out before the ride) would
 * hit auto_start_blocked on every single GPS sample crossing the start threshold, for the
 * entire ride, with the board genuinely connected the whole time. registerPairedDevice is
 * idempotent (no-ops once already registered for this devId) and already calls
 * TuyaBleNative.connectDevice internally, so this fully subsumes the old direct call. */
export async function ensureBleConnected(): Promise<void> {
  const devId = await getPairedDeviceId();
  if (devId) registerPairedDevice(devId);
}

/** Foreground-return reconnect kick — unlike ensureBleConnected()'s no-op-if-already-
 * registered nudge, this actually interrupts an in-progress exponential backoff wait
 * (5s → up to 300s between scan windows, see BoardBleClient's RECONNECT_MAX_MS) so the
 * client restarts its connect cycle immediately with a fresh scan instead of sitting out
 * whatever delay it had already grown to, which could be minutes.
 *
 * Calls the native client's own restartNow() (via reconnectNow) on the SAME client
 * instance — it does NOT tear the client down and re-register a new one, the way this
 * used to. Confirmed live: doing that raced the app's own first connect attempt and tore
 * down a handshake that had just succeeded (`connection state out of sync — native says
 * disconnected` ~150ms after `handshake succeeded`), and every JS-runtime restart while
 * the same native process lived left the old, torn-down client running as a zombie that
 * kept fighting the new one for the same board.
 *
 * No-ops if nothing's paired, if the board is already connected (nothing to kick), or
 * if the rider deliberately disconnected — foregrounding the app must never silently
 * override that choice the way retryBoardConnection()'s explicit "Try again" does. */
export async function kickReconnectOnForeground(): Promise<void> {
  if (isManuallyDisconnected()) return;
  const devId = await getPairedDeviceId();
  if (!devId) return;
  if (getBleSessionState().online === true) return;
  directReconnectNow(devId);
}

/** Rider-triggered disconnect. Tears the session down so the native client stops its
 * reconnect loop — otherwise "disconnect" would look like a dropout and the client
 * would simply reconnect a few seconds later. The board stays paired; reconnecting is
 * retryBoardConnection (or the next app launch). */
export async function disconnectBoard(): Promise<void> {
  const devId = await getPairedDeviceId();
  if (!devId) return;
  logEvent('board-link', 'rider disconnected the board', { devId });
  holdDisconnected();
}

/** Rider-triggered "try again" for a paired board that isn't connected. Tears the
 * session down and re-registers, so the permission prompt is re-issued (Android only
 * shows it while the app is asking) and the native client restarts its scan instead of
 * sitting in its backoff. Returns false if the permission was declined again. */
export async function retryBoardConnection(): Promise<boolean> {
  const devId = await getPairedDeviceId();
  if (!devId) return false;
  if (!(await ensureBlePermissions())) return false;
  clearDisconnectHold();
  teardownRegisteredDevice();
  registerPairedDevice(devId);
  // Defensive re-assert, not a restore: teardownRegisteredDevice no longer stops
  // background reconnection on its own (see its comment), but a "Try again" tap is also
  // exactly when Bluetooth permission may have only just been granted, so background
  // reconnect may never have been armed for this board yet.
  await applyBackgroundSelfHeal();
  return true;
}

export type BleConnectionStatus = {
  /** Whether a board is paired *at all* — independent of live online/offline, so
   * "paired, waiting for first status" is never confused with "nothing paired". */
  paired: boolean;
  /** null until the first onDeviceStatusChanged event arrives for a paired device. */
  online: boolean | null;
  /** True when the device's own schema reports an active charging state. */
  charging: boolean | null;
  /** True once the shared 10-second connection-search window has expired. */
  searchingTimeout: boolean;
  /** True when the Bluetooth permission was declined, so no scan can ever succeed. */
  permissionDenied: boolean;
  /** True when the rider pressed Disconnect — not a fault, and not something to
   * suggest waking the board over. */
  manuallyDisconnected: boolean;
};

/** Single verdict combining paired/online/charging — trip-lifecycle code reacts to
 * this instead of learning BLE's session internals directly. */
export type BoardUsability = 'unpaired' | 'connecting' | 'usable' | 'charging' | 'offline';

export function getBoardUsability(): BoardUsability {
  const session = getBleSessionState();
  if (!session.paired) return 'unpaired';
  if (session.online === false) return 'offline';
  if (session.online !== true) return 'connecting';
  return session.charging === true ? 'charging' : 'usable';
}

/** Shared subscribe-by-paired-device primitive: waits for the paired devId, then
 * subscribes to the shared BLE session, projecting through `select`. Guards against
 * setting state after unmount, and re-subscribes on `usePairedDeviceEpoch()` change
 * so a hook mounted before pairing still picks up the device once one exists.
 * `onRegister` runs a one-off side effect (e.g. kick off a hydrate/load) once the
 * devId is known, before the subscription is created. */
function useBleSessionField<T>(select: (s: SessionState) => T, initialValue: T, onRegister?: (devId: string) => void): T {
  const [value, setValue] = useState<T>(initialValue);
  const pairedEpoch = usePairedDeviceEpoch();

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    getPairedDeviceId().then((devId) => {
      if (cancelled || !devId) return;
      onRegister?.(devId);
      unsubscribe = subscribeBleSession(devId, (s) => {
        if (!cancelled) setValue(select(s));
      });
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairedEpoch]);

  return value;
}

/** Live online/offline for the paired device. Backed by the shared session so every mounted indicator agrees. */
export function useBleConnectionStatus(): BleConnectionStatus {
  return useBleSessionField(
    (s) => ({
      paired: s.paired,
      online: s.online,
      charging: s.charging,
      searchingTimeout: s.searchingTimeout,
      permissionDenied: s.permissionDenied,
      manuallyDisconnected: isManuallyDisconnected(),
    }),
    { paired: false, online: null, charging: null, searchingTimeout: false, permissionDenied: false, manuallyDisconnected: false },
  );
}

/** Live raw DP values keyed by numeric dpId (not the Cloud API's human-readable codes). Registers the native listener itself, not dependent on another component having done so. */
export function useBleRawDps(): Record<string, unknown> | null {
  return useBleSessionField((s) => s.dps, getCachedDps());
}

/** Per-dpId Tuya product schema, drives board-config.tsx's editable controls. Null until loaded, empty object if unavailable after retrying. */
export function useBleSchema(): Record<string, BoardDpSchema> | null {
  return useBleSessionField(
    (s) => s.schema,
    getCachedSchema(),
    (devId) => ensureSchemaLoaded(devId),
  );
}

/** The queued values themselves, so a control can show what the rider chose rather
 * than the board's stale value while a change waits for a reconnect. */
export function usePendingSettings(): Record<string, BoardSettingValue> {
  return useBleSessionField(
    (s) => s.pendingSettings,
    getPendingSettings(),
    () => ensurePendingSettingsHydrated(),
  );
}

/** Count of dpIds saved while offline, not yet applied — 0 means fully synced, >0 applies automatically on reconnect. */
export function usePendingSettingsCount(): number {
  return useBleSessionField(
    (s) => Object.keys(s.pendingSettings).length,
    Object.keys(getPendingSettings()).length,
    () => ensurePendingSettingsHydrated(),
  );
}

// ---------------------------------------------------------------------------
// The former lib/deviceLink/session.ts and lib/bleConnectionEvents.ts now live under
// deviceLink/ and are re-exported here so every existing consumer keeps importing
// from one module.
// ---------------------------------------------------------------------------
export * from '@/features/device/deviceLink/session';
export * from '@/features/device/deviceLink/connectionEvents';

// lib/bleStatusRefresh.ts also folded into deviceLink/ (as deviceLink/statusRefresh.ts),
// but it is NOT re-exported here: it's a side-effect module (starts the foreground
// refresh poll on import) that reads tripRecorder.isTripActive(), so re-exporting it
// from the door would make every door import transitively load the trip recorder —
// wrong weight for consumers that only want session/snapshot access, and a
// tripRecorder→deviceLink load cycle. app/_layout.tsx imports it directly instead,
// same as the old `import '@/lib/bleStatusRefresh'`.
