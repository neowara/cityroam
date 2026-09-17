import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import { appReleaseApi, type LatestRelease } from '@/lib/api';
import AppUpdaterNative, { type InstallStatusEvent } from '@modules/app-updater/src/AppUpdater';
import { createListenable } from '@/lib/listenable';
import { hapticUpdateFailure, hapticUpdateSuccess } from '@/lib/haptics';
import { logEvent } from '@/lib/log';
import RideCoreNative from '@modules/ride-core/src/RideCore';
import { tripRecorder } from '@/features/rides/tripRecorder';

// ---------------------------------------------------------------- version compare

/** Strict `X.Y.Z` numeric compare. Malformed input on either side never counts as an
 * update — returns `null` rather than guessing, so callers fail closed (no banner)
 * instead of showing one over a version string this can't actually reason about. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const partsA = parseVersion(a);
  const partsB = parseVersion(b);
  if (!partsA || !partsB) return null;
  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}

/** `candidate` is a real update over `current` — strictly newer, and only when both
 * sides parse as a real `X.Y.Z` version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}

function parseVersion(v: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function currentAppVersion(): string | null {
  return Constants.expoConfig?.version ?? null;
}

// -------------------------------------------------------------- check throttling

const LAST_CHECKED_KEY = 'turbo.appUpdate.lastCheckedAt';
const CACHED_RELEASE_KEY = 'turbo.appUpdate.cachedLatestRelease';
const DISMISSED_VERSION_KEY = 'turbo.appUpdate.dismissedVersion';

const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;

/** Pure decision behind the throttle — separated from the AsyncStorage reads/writes so
 * it's unit-testable without mocking storage or real timers. */
export function shouldCheckNow(lastCheckedAtMs: number | null, nowMs: number, force: boolean): boolean {
  if (force) return true;
  if (lastCheckedAtMs == null) return true;
  return nowMs - lastCheckedAtMs > CHECK_THROTTLE_MS;
}

async function getLastCheckedAt(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(LAST_CHECKED_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getCachedRelease(): Promise<LatestRelease | null> {
  const raw = await AsyncStorage.getItem(CACHED_RELEASE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LatestRelease;
  } catch {
    return null;
  }
}

async function setCachedRelease(release: LatestRelease | null): Promise<void> {
  if (release) await AsyncStorage.setItem(CACHED_RELEASE_KEY, JSON.stringify(release));
  else await AsyncStorage.removeItem(CACHED_RELEASE_KEY);
}

export async function getDismissedVersion(): Promise<string | null> {
  return AsyncStorage.getItem(DISMISSED_VERSION_KEY);
}

export async function dismissVersion(version: string): Promise<void> {
  await AsyncStorage.setItem(DISMISSED_VERSION_KEY, version);
}

/** Pure decision behind whether `<UpdateBanner>` renders at all — dismissed per
 * version, not forever, same "dismiss per state" idea `ReadinessBanner` already uses:
 * fixing nothing and a newer release showing up later still surfaces it, but the
 * version the rider already said "later" to stays hidden. */
export function shouldShowBanner(latestVersion: string, currentVersion: string, dismissedVersion: string | null): boolean {
  if (!isNewerVersion(latestVersion, currentVersion)) return false;
  return dismissedVersion !== latestVersion;
}

/**
 * Checks the backend for the latest release, throttled to once every 6h across app
 * restarts (persisted in AsyncStorage, not just react-query's in-memory staleTime,
 * which resets on every cold start). `force` (Settings' manual "Check for updates")
 * skips the throttle entirely.
 *
 * Never throws: a failed check (offline, backend down, misconfigured server) logs and
 * falls back to whatever the last successful check found, so a transient network blip
 * doesn't flash the update banner away. Runs whether or not the rider is signed in —
 * appReleaseApi calls the public, unauthenticated endpoints.
 */
export async function checkForUpdate(force = false): Promise<LatestRelease | null> {
  const now = Date.now();
  if (!(await shouldCheckNowPersisted(now, force))) {
    return getCachedRelease();
  }
  try {
    const release = (await appReleaseApi.latestRelease()) ?? null;
    await AsyncStorage.setItem(LAST_CHECKED_KEY, String(now));
    await setCachedRelease(release);
    return release;
  } catch (err) {
    logEvent('appUpdate', 'update check failed — banner keeps showing whatever the last successful check found', {
      error: err instanceof Error ? err.message : String(err),
    });
    return getCachedRelease();
  }
}

async function shouldCheckNowPersisted(now: number, force: boolean): Promise<boolean> {
  return shouldCheckNow(await getLastCheckedAt(), now, force);
}

const APP_UPDATE_QUERY_KEY = ['appRelease', 'latest'] as const;

/** Runs whether or not the rider is signed in — that's the whole point of the public
 * endpoints (a rider stuck on a broken login must still be able to see and install the
 * fix). Errors never surface to the UI; see checkForUpdate's own doc comment. */
export function useAppUpdate(): UseQueryResult<LatestRelease | null> {
  return useQuery({
    queryKey: APP_UPDATE_QUERY_KEY,
    queryFn: () => checkForUpdate(false),
    staleTime: CHECK_THROTTLE_MS,
    retry: 1,
  });
}

/** The unthrottled manual check behind Settings' "Check for updates" row — bypasses the
 * 6h gate and seeds the shared query cache with the result, so the dashboard/login
 * banners reflect it immediately instead of waiting for their own next refetch. */
export function useManualAppUpdateCheck() {
  const queryClient = useQueryClient();
  return {
    check: async (): Promise<LatestRelease | null> => {
      const release = await checkForUpdate(true);
      queryClient.setQueryData(APP_UPDATE_QUERY_KEY, release);
      return release;
    },
  };
}

// --------------------------------------------------------------------- downloads

const UPDATES_DIR_NAME = 'updates';

function updatesDirectory(): Directory {
  return new Directory(Paths.cache, UPDATES_DIR_NAME);
}

/** Deletes every file in the updates directory except (optionally) one being kept —
 * the in-progress or just-verified download. Creates the directory if it doesn't exist
 * yet rather than throwing on a fresh install. */
function cleanUpdatesDirectory(keep?: File): Directory {
  const dir = updatesDirectory();
  if (!dir.exists) {
    dir.create({ intermediates: true });
    return dir;
  }
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.uri === keep?.uri) continue;
    try {
      entry.delete();
    } catch (err) {
      logEvent('appUpdate', 'could not clean up a stale file in the updates cache', {
        uri: entry.uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return dir;
}

/** Parses the versionCode-free `X.Y.Z` out of `TurboVX.Y.Z.apk`, the asset name the
 * release script produces — used to recognize a cached APK left over from a version
 * that's since been installed, so it can be swept up on launch without re-deriving the
 * release metadata that produced it. */
export function versionFromApkName(name: string): string | null {
  const match = /^TurboV(\d+\.\d+\.\d+)\.apk$/.exec(name);
  return match ? match[1] : null;
}

/** Call once at launch — sweeps any cached APK for a version the app has already
 * caught up to (a completed update, or the rider updated some other way). Best-effort;
 * a stale multi-megabyte file left behind is a disk-space nit, never worth crashing
 * launch over. */
export function cleanUpInstalledApkFromCache(): void {
  try {
    const dir = updatesDirectory();
    if (!dir.exists) return;
    const installed = currentAppVersion();
    if (!installed) return;
    for (const entry of dir.list()) {
      if (!(entry instanceof File)) continue;
      const cachedVersion = versionFromApkName(entry.name);
      if (cachedVersion && !isNewerVersion(cachedVersion, installed)) {
        entry.delete();
      }
    }
  } catch (err) {
    logEvent('appUpdate', 'could not sweep the updates cache on launch', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ------------------------------------------------------------------ flow state

export type UpdateFailureReason =
  | 'unverifiable' // no sha256 from the backend — refuse to install unverified
  | 'download' // the download itself failed or there's no network
  | 'fileMismatch' // sha256/package/version check failed — not the release it claims to be
  | 'signatureMismatch' // signing certificate didn't match the installed app
  | 'storage' // not enough space for PackageInstaller to stage the session
  | 'blocked' // installer refused for any other reason (conflict, invalid, aborted, ...)
  | 'cancelled'; // the system's own install-confirmation dialog was dismissed

export type UpdateFlowState =
  | { step: 'idle' }
  | { step: 'blockedByRide' }
  | { step: 'resolvingUrl' }
  | { step: 'downloading'; bytesWritten: number; totalBytes: number }
  | { step: 'verifying' }
  | { step: 'needsInstallPermission' }
  | { step: 'installing' }
  | { step: 'pendingUserAction' }
  | { step: 'failed'; reason: UpdateFailureReason }
  | { step: 'success' };

const IDLE_STATE: UpdateFlowState = { step: 'idle' };

/**
 * Whether the shared update modal is open — module-scope, not per-component state, for
 * one reason: this app's tab navigator doesn't unmount inactive tabs (see
 * `app/(tabs)/index.tsx`'s own comment on that), and `<UpdateBanner>` mounts on both the
 * dashboard and the login screen while Settings' "Check for updates" row can open the
 * same modal content from a third place. Local `useState` per call site would let two
 * of those actually render a real native `Modal` at once if the rider opened one and
 * navigated away without closing it — a confirmed, real Android performance problem
 * (AGENTS.md's modal-stacking rule), not just a style preference. One shared flag means
 * there is only ever one `<AppModal>` in the tree with `visible={true}`.
 */
class UpdateModalVisibility {
  private visible = false;
  private readonly store = createListenable();
  subscribe = this.store.subscribe;
  getSnapshot = (): boolean => this.visible;
  open(): void {
    this.visible = true;
    this.store.notify();
  }
  close(): void {
    this.visible = false;
    this.store.notify();
  }
}

export const updateModalVisibility = new UpdateModalVisibility();

/**
 * The update install flow, as an explicit state machine — module-scope, not component
 * state, so a download in progress survives the modal closing and reopening, and screen
 * navigation. Exposed through createListenable so any component can subscribe with
 * useSyncExternalStore, the same pattern lib/tripRecorder.ts uses for its own snapshot.
 */
class UpdateFlow {
  private state: UpdateFlowState = IDLE_STATE;
  private readonly store = createListenable();
  private release: LatestRelease | null = null;
  private downloadTask: DownloadTask | null = null;
  private installStatusSubscription: { remove: () => void } | null = null;
  private verifiedFile: File | null = null;

  subscribe = this.store.subscribe;
  getSnapshot = (): UpdateFlowState => this.state;

  /** The release this flow is actually running against, once `start()` has been
   * called — distinct from `useAppUpdate()`'s query cache, which a manual "Check for
   * updates" elsewhere can overwrite (with a different release, or `null` on a
   * transient miss) while this flow is still mid-download/verify/install. `release` is
   * always set synchronously before the first `setState` in `start()`, so any read
   * that follows a `flowState` change from `subscribe` already sees the release that
   * produced it — callers should prefer this over the query's release whenever
   * `state.step !== 'idle'`, so an unrelated refetch can never strand a flow that still
   * needs the rider's attention (needsInstallPermission, failed) with no UI to reach
   * it. Stays set (not cleared) through `reset()`/`success`, harmlessly — it's only
   * ever consulted while a step other than idle is active. */
  getActiveRelease = (): LatestRelease | null => this.release;

  private setState(next: UpdateFlowState): void {
    this.state = next;
    logEvent('appUpdate', `flow -> ${next.step}`, next.step === 'failed' ? { reason: next.reason } : undefined);
    this.store.notify();
  }

  /** True while any step other than idle/blockedByRide/failed/success is active — used
   * to disable the "Download and install" action so a rider can't double-tap it into
   * two concurrent downloads. */
  isActive(): boolean {
    return !['idle', 'blockedByRide', 'failed', 'success'].includes(this.state.step);
  }

  /** Starts (or resumes into) the flow for `release`. Safe to call again for the same
   * release while a previous attempt is sitting in `failed` — that's exactly "Try
   * again," and a previously verified cached APK (see cleanUpdatesDirectory's `keep`)
   * means a retry after an install-stage failure doesn't re-download 65 MB. */
  async start(release: LatestRelease): Promise<void> {
    if (this.isActive()) return; // already running — never a double-start
    this.release = release;

    if (tripRecorder.isTripActive() || RideCoreNative.isRunning()) {
      this.setState({ step: 'blockedByRide' });
      return;
    }
    if (!release.sha256) {
      this.setState({ step: 'failed', reason: 'unverifiable' });
      return;
    }

    const target = new File(updatesDirectory(), release.assetName);
    if (target.exists) {
      // Set synchronously, before the first await below — isActive() must already read
      // true the instant a second call could possibly race this one (a rapid
      // double-tap), same reasoning as download()'s own immediate 'resolvingUrl' set.
      this.setState({ step: 'verifying' });
      const check = await AppUpdaterNative.verifyApk(target.uri, release.sha256);
      if (check.ok) {
        await this.afterVerified(target);
        return;
      }
      // Cached file doesn't match this release after all — fall through to a real
      // (re)download rather than trusting a half-written or stale leftover.
      cleanUpdatesDirectory();
    }

    await this.download(release, target);
  }

  private async download(release: LatestRelease, target: File): Promise<void> {
    this.setState({ step: 'resolvingUrl' });
    let url: string;
    try {
      url = (await appReleaseApi.releaseDownloadUrl(release.version)).url;
    } catch (err) {
      logEvent('appUpdate', 'could not resolve the download URL', { error: err instanceof Error ? err.message : String(err) });
      this.setState({ step: 'failed', reason: 'download' });
      return;
    }

    cleanUpdatesDirectory(target);
    this.setState({ step: 'downloading', bytesWritten: 0, totalBytes: release.sizeBytes });

    const task = File.createDownloadTask(url, target, {
      onProgress: ({ bytesWritten, totalBytes }) => {
        if (this.state.step !== 'downloading') return;
        this.setState({ step: 'downloading', bytesWritten, totalBytes: totalBytes > 0 ? totalBytes : release.sizeBytes });
      },
    });
    this.downloadTask = task;

    let downloaded: File | null;
    try {
      downloaded = await task.downloadAsync();
    } catch (err) {
      this.downloadTask = null;
      // cancelDownload() below already moved the flow back to idle and deleted the
      // partial file — a cancellation rejecting here is expected, not a real failure.
      if (this.state.step !== 'downloading' && this.state.step !== 'resolvingUrl') return;
      logEvent('appUpdate', 'download failed', { error: err instanceof Error ? err.message : String(err) });
      try {
        if (target.exists) target.delete();
      } catch {
        // best-effort
      }
      this.setState({ step: 'failed', reason: 'download' });
      return;
    }
    this.downloadTask = null;
    if (!downloaded) return; // paused — this flow never pauses/resumes, so treat as a no-op

    this.setState({ step: 'verifying' });
    const check = await AppUpdaterNative.verifyApk(downloaded.uri, release.sha256!);
    if (!check.ok) {
      logEvent('appUpdate', 'downloaded APK failed verification', { reason: check.reason });
      try {
        downloaded.delete();
      } catch {
        // best-effort
      }
      this.setState({ step: 'failed', reason: check.reason === 'signatureMismatch' ? 'signatureMismatch' : 'fileMismatch' });
      return;
    }
    await this.afterVerified(downloaded);
  }

  private async afterVerified(file: File): Promise<void> {
    this.verifiedFile = file;
    if (!AppUpdaterNative.canRequestPackageInstalls()) {
      this.setState({ step: 'needsInstallPermission' });
      return;
    }
    await this.install(file);
  }

  /** Called from useAppForegroundEffect once the rider returns from the "Install
   * unknown apps" settings screen — re-checks the permission and continues
   * automatically the moment it's granted, rather than making the rider tap something
   * else after already having gone to Settings and back. A no-op unless the flow is
   * actually sitting in needsInstallPermission. */
  recheckInstallPermission(): void {
    if (this.state.step !== 'needsInstallPermission' || !this.verifiedFile) return;
    if (AppUpdaterNative.canRequestPackageInstalls()) {
      void this.install(this.verifiedFile);
    }
  }

  /** Opens the per-app "Install unknown apps" settings page — the one native call the
   * UI (`components/ui/UpdateBanner.tsx`) makes directly rather than importing
   * AppUpdaterNative itself, keeping every other native touchpoint in this file. */
  openInstallPermissionSettings(): Promise<void> {
    return AppUpdaterNative.openInstallPermissionSettings();
  }

  /** Called from useForegroundReturnEffect (a genuine return, never on mount) — there's
   * no native "the system dialog was dismissed" event, so returning to the app while
   * still sitting in pendingUserAction is the only signal available that the rider
   * closed it without completing the install. A real success/failure that arrives via
   * onInstallStatus after this already moved the flow out of pendingUserAction, so
   * there's nothing left for a late-arriving foreground return to clobber. */
  onForegroundReturn(): void {
    if (this.state.step === 'pendingUserAction') {
      this.setState({ step: 'failed', reason: 'cancelled' });
    }
  }

  private async install(file: File): Promise<void> {
    // Re-checked here, not just at the top of start(): a download/verify can take
    // long enough for a ride to have started in the meantime, and installing kills the
    // process outright — the exact pocket-ride scenario the ride guard exists for.
    if (tripRecorder.isTripActive() || RideCoreNative.isRunning()) {
      this.setState({ step: 'blockedByRide' });
      return;
    }
    this.setState({ step: 'installing' });
    this.ensureInstallStatusListener();
    try {
      await AppUpdaterNative.installApk(file.uri);
    } catch (err) {
      logEvent('appUpdate', 'installApk rejected', { error: err instanceof Error ? err.message : String(err) });
      this.setState({ step: 'failed', reason: 'blocked' });
    }
    // On success the session was committed — the actual outcome (success /
    // pendingUserAction / failure) arrives asynchronously via onInstallStatus.
  }

  private ensureInstallStatusListener(): void {
    if (this.installStatusSubscription) return;
    this.installStatusSubscription = AppUpdaterNative.addListener('onInstallStatus', (event: InstallStatusEvent) => {
      this.handleInstallStatus(event);
    });
  }

  private handleInstallStatus(event: InstallStatusEvent): void {
    if (event.status === 'success') {
      hapticUpdateSuccess();
      this.setState({ step: 'success' });
      return;
    }
    if (event.status === 'pendingUserAction') {
      this.setState({ step: 'pendingUserAction' });
      return;
    }
    hapticUpdateFailure();
    logEvent('appUpdate', 'install failed', { code: event.code, message: event.message });
    this.setState({ step: 'failed', reason: installFailureReason(event.code) });
  }

  /** "Cancel" during resolvingUrl/downloading (D2's table) — cancels the in-flight
   * task, deletes the partial file, and returns to idle so the modal falls back to the
   * "available" screen instead of showing a dead progress bar. */
  cancelDownload(): void {
    if (this.state.step !== 'resolvingUrl' && this.state.step !== 'downloading') return;
    this.downloadTask?.cancel();
    this.downloadTask = null;
    if (this.release) {
      const target = new File(updatesDirectory(), this.release.assetName);
      try {
        if (target.exists) target.delete();
      } catch {
        // best-effort
      }
    }
    this.setState(IDLE_STATE);
  }

  /** "Try again" from a failed state, or resuming after "Install was cancelled" — both
   * just re-run start() for the same release, which naturally reuses a still-cached
   * verified APK when the failure happened at or after verification. */
  retry(): void {
    if (!this.release) return;
    void this.start(this.release);
  }

  /** Resets to idle without touching any cached file — used when the rider backs out
   * of a failure/pendingUserAction screen ("Close") rather than retrying. */
  reset(): void {
    if (this.state.step === 'downloading' || this.state.step === 'resolvingUrl') {
      this.cancelDownload();
      return;
    }
    this.setState(IDLE_STATE);
  }
}

function installFailureReason(code: string): UpdateFailureReason {
  switch (code) {
    case 'STORAGE':
      return 'storage';
    default:
      return 'blocked';
  }
}

export const updateFlow = new UpdateFlow();
