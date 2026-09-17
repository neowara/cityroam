import AsyncStorage from '@react-native-async-storage/async-storage';

import type { NativeRide } from '@modules/ride-core/src/RideCore';

jest.mock('@/lib/log', () => ({ logEvent: jest.fn(), flushRemoteLog: jest.fn() }));
jest.mock('@/lib/haptics', () => ({ hapticUpdateSuccess: jest.fn(), hapticUpdateFailure: jest.fn() }));

const mockIsTripActive = jest.fn((..._args: unknown[]) => false);
jest.mock('@/features/rides/tripRecorder', () => ({ tripRecorder: { isTripActive: (...args: unknown[]) => mockIsTripActive(...args) } }));

const mockGetActiveRide = jest.fn((..._args: unknown[]): NativeRide | null => null);
const mockGetRideLastActivityMs = jest.fn((..._args: unknown[]): number | null => null);
jest.mock('@modules/ride-core/src/RideCore', () => ({
  __esModule: true,
  default: {
    getActiveRide: (...args: unknown[]) => mockGetActiveRide(...args),
    getRideLastActivityMs: (...args: unknown[]) => mockGetRideLastActivityMs(...args),
  },
}));

/** A native open-ride row, fully typed so the stub can't silently drift from the real
 * shape the guard reads. */
const nativeRide = (overrides: Partial<NativeRide> = {}): NativeRide => ({
  id: 1,
  startMs: Date.now(),
  endMs: null,
  state: 'open',
  wasManual: false,
  odoStartKm: null,
  odoEndKm: null,
  batteryStartPct: null,
  batteryEndPct: null,
  distanceKm: null,
  maxSpeedKmh: null,
  endReason: null,
  backendId: null,
  ...overrides,
});

const mockLatestRelease = jest.fn();
const mockReleaseDownloadUrl = jest.fn();
jest.mock('@/lib/api', () => ({
  appReleaseApi: {
    latestRelease: (...args: unknown[]) => mockLatestRelease(...args),
    releaseDownloadUrl: (...args: unknown[]) => mockReleaseDownloadUrl(...args),
  },
}));

const mockCanRequestPackageInstalls = jest.fn((..._args: unknown[]) => true);
const mockVerifyApk = jest.fn();
const mockInstallApk = jest.fn();
const mockAddListener = jest.fn((..._args: unknown[]) => ({ remove: jest.fn() }));
jest.mock('@modules/app-updater/src/AppUpdater', () => ({
  __esModule: true,
  default: {
    canRequestPackageInstalls: (...args: unknown[]) => mockCanRequestPackageInstalls(...args),
    openInstallPermissionSettings: jest.fn(),
    installedVersionCode: () => 1,
    verifyApk: (...args: unknown[]) => mockVerifyApk(...args),
    installApk: (...args: unknown[]) => mockInstallApk(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

// Classes defined inline inside the factory, not referenced from an outer variable —
// babel-plugin-jest-hoist moves every jest.mock() call (and the transpiled `import`
// statements needing it) above ordinary module-level declarations, so a `class MockFile
// {}` (or even `const MockFile = class {}`) declared below the mock call still hadn't
// run yet by the time '@/features/updates/appUpdate' was required and read File/Directory off as
// undefined —. Defining the classes inside the factory itself sidesteps
// the ordering question entirely: the factory only ever runs, in full, at require time.
jest.mock('expo-file-system', () => ({
  __esModule: true,
  File: class {
    exists = false;
    uri: string;
    name: string;
    delete = jest.fn();
    constructor(...parts: unknown[]) {
      this.uri = parts.map(String).join('/');
      this.name = String(parts[parts.length - 1]);
    }
    static createDownloadTask = jest.fn();
  },
  Directory: class {
    exists = true;
    uri: string;
    create = jest.fn();
    list = jest.fn(() => []);
    constructor(...parts: unknown[]) {
      this.uri = parts.map(String).join('/');
    }
  },
  Paths: { cache: 'file:///cache' },
}));

import { compareVersions, isNewerVersion, shouldCheckNow, shouldShowBanner, updateFlow } from '@/features/updates/appUpdate';
// The mocked classes themselves — imported the normal way (they resolve to the ones
// defined in the factory above), rather than kept as a separate module-scope reference.
import { File as MockFile } from 'expo-file-system';

const release = (overrides: Partial<Parameters<typeof mockLatestRelease>[0]> = {}) => ({
  version: '4.3.0',
  tag: 'v4.3.0',
  name: 'Cityroam 4.3.0',
  notes: '- fixed things',
  publishedAt: '2026-09-01T00:00:00Z',
  assetName: 'TurboV4.3.0.apk',
  sizeBytes: 1000,
  sha256: 'a'.repeat(64),
  ...overrides,
});

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('4.10.0', '4.9.9')).toBe(1);
    expect(compareVersions('4.9.9', '4.10.0')).toBe(-1);
  });

  it('reports equal versions as 0', () => {
    expect(compareVersions('4.2.3', '4.2.3')).toBe(0);
  });

  it('never counts malformed input as an update', () => {
    expect(compareVersions('not-a-version', '4.2.3')).toBeNull();
    expect(compareVersions('4.2.3', 'not-a-version')).toBeNull();
    expect(compareVersions('4.2', '4.2.3')).toBeNull();
    expect(isNewerVersion('not-a-version', '4.2.3')).toBe(false);
  });
});

describe('shouldShowBanner', () => {
  it('shows for a genuinely newer, non-dismissed version', () => {
    expect(shouldShowBanner('4.3.0', '4.2.3', null)).toBe(true);
  });

  it('hides for the same version', () => {
    expect(shouldShowBanner('4.2.3', '4.2.3', null)).toBe(false);
  });

  it('hides for an older "latest" than what is installed', () => {
    expect(shouldShowBanner('4.2.0', '4.2.3', null)).toBe(false);
  });

  it('hides once the exact newer version has been dismissed', () => {
    expect(shouldShowBanner('4.3.0', '4.2.3', '4.3.0')).toBe(false);
  });

  it('a dismissal for an older version does not hide a newer one that showed up later', () => {
    expect(shouldShowBanner('4.4.0', '4.2.3', '4.3.0')).toBe(true);
  });
});

describe('shouldCheckNow (persisted throttle)', () => {
  const now = 1_000_000;
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  it('always checks when forced, regardless of how recently checked', () => {
    expect(shouldCheckNow(now - 1, now, true)).toBe(true);
  });

  it('always checks when never checked before', () => {
    expect(shouldCheckNow(null, now, false)).toBe(true);
  });

  it('skips when checked well within the last 6h', () => {
    expect(shouldCheckNow(now - 60_000, now, false)).toBe(false);
  });

  it('checks again once more than 6h have passed', () => {
    expect(shouldCheckNow(now - SIX_HOURS - 1, now, false)).toBe(true);
  });
});

describe('updateFlow ride guard and verification', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockIsTripActive.mockReturnValue(false);
    mockGetActiveRide.mockReturnValue(null);
    mockGetRideLastActivityMs.mockReturnValue(null);
    mockCanRequestPackageInstalls.mockReturnValue(true);
    mockVerifyApk.mockReset();
    mockInstallApk.mockReset().mockResolvedValue(undefined);
    mockReleaseDownloadUrl.mockReset();
    (MockFile.createDownloadTask as jest.Mock).mockReset();
    updateFlow.reset();
  });

  it('refuses to start while a trip is actively recording', async () => {
    mockIsTripActive.mockReturnValue(true);

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'blockedByRide' });
    expect(mockReleaseDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses to start while the native journal holds a live open ride, even if the JS recorder is idle', async () => {
    mockGetActiveRide.mockReturnValue(nativeRide());
    mockGetRideLastActivityMs.mockReturnValue(Date.now() - 30_000);

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'blockedByRide' });
  });

  it('a stale open row does not block forever — only board telemetry can close a row, so a ride the process died in stays open indefinitely once the board is gone', async () => {
    const longAgo = Date.now() - 6 * 60 * 60 * 1000;
    mockGetActiveRide.mockReturnValue(nativeRide({ startMs: longAgo }));
    mockGetRideLastActivityMs.mockReturnValue(longAgo);
    mockReleaseDownloadUrl.mockRejectedValue(new Error('stop here'));

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).not.toEqual({ step: 'blockedByRide' });
    expect(mockReleaseDownloadUrl).toHaveBeenCalled();
  });

  it('an open row with no samples at all falls back to its own start time', async () => {
    mockGetActiveRide.mockReturnValue(nativeRide({ startMs: Date.now() - 5_000 }));
    mockGetRideLastActivityMs.mockReturnValue(null);

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'blockedByRide' });
  });

  it('a ride that starts mid-flow blocks the actual install, not just the initial start() call', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    // Flips to true only once verifyApk is actually called — simulates a ride starting
    // during the download/verify window, after start()'s own initial guard already
    // passed clean.
    mockVerifyApk.mockImplementation(async () => {
      mockIsTripActive.mockReturnValue(true);
      return { ok: true, versionName: '4.3.0', versionCode: 43 };
    });
    const downloadedFile = new MockFile('file:///cache/updates/TurboV4.3.0.apk');
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(downloadedFile),
      cancel: jest.fn(),
    });

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'blockedByRide' });
    expect(mockInstallApk).not.toHaveBeenCalled();
  });

  it('a release with no sha256 is refused as unverifiable — never installs unverified', async () => {
    await updateFlow.start(release({ sha256: null }));

    expect(updateFlow.getSnapshot()).toEqual({ step: 'failed', reason: 'unverifiable' });
    expect(mockReleaseDownloadUrl).not.toHaveBeenCalled();
  });

  it('downloads, verifies, and installs a clean release end to end, reaching success once onInstallStatus fires', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    mockVerifyApk.mockResolvedValue({ ok: true, versionName: '4.3.0', versionCode: 43 });

    let progressCb: ((p: { bytesWritten: number; totalBytes: number }) => void) | undefined;
    const downloadedFile = new MockFile('file:///cache/updates/TurboV4.3.0.apk');
    (MockFile.createDownloadTask as jest.Mock).mockImplementation(
      (_url: string, _dest: unknown, opts: { onProgress?: typeof progressCb }) => {
        progressCb = opts.onProgress;
        return {
          downloadAsync: jest.fn().mockImplementation(async () => {
            progressCb?.({ bytesWritten: 500, totalBytes: 1000 });
            return downloadedFile;
          }),
          cancel: jest.fn(),
        };
      },
    );

    let installListener: ((e: { status: string; code?: string; message?: string }) => void) | undefined;
    mockAddListener.mockImplementation((...args: unknown[]) => {
      installListener = args[1] as typeof installListener;
      return { remove: jest.fn() };
    });

    const startPromise = updateFlow.start(release());
    await startPromise;

    expect(mockInstallApk).toHaveBeenCalledWith(downloadedFile.uri);
    expect(updateFlow.getSnapshot()).toEqual({ step: 'installing' });

    installListener?.({ status: 'success' });
    expect(updateFlow.getSnapshot()).toEqual({ step: 'success' });
  });

  it('a sha256 mismatch after download fails closed as fileMismatch and deletes the bad file', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    mockVerifyApk.mockResolvedValue({ ok: false, reason: 'sha256Mismatch' });
    const downloadedFile = new MockFile('file:///cache/updates/TurboV4.3.0.apk');
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(downloadedFile),
      cancel: jest.fn(),
    });

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'failed', reason: 'fileMismatch' });
    expect(downloadedFile.delete).toHaveBeenCalled();
    expect(mockInstallApk).not.toHaveBeenCalled();
  });

  it('a signature mismatch reports the distinct signatureMismatch reason, not the generic fileMismatch one', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    mockVerifyApk.mockResolvedValue({ ok: false, reason: 'signatureMismatch' });
    const downloadedFile = new MockFile('file:///cache/updates/TurboV4.3.0.apk');
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(downloadedFile),
      cancel: jest.fn(),
    });

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'failed', reason: 'signatureMismatch' });
  });

  it('missing the install permission stops at needsInstallPermission rather than calling installApk', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    mockVerifyApk.mockResolvedValue({ ok: true, versionName: '4.3.0', versionCode: 43 });
    mockCanRequestPackageInstalls.mockReturnValue(false);
    const downloadedFile = new MockFile('file:///cache/updates/TurboV4.3.0.apk');
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockResolvedValue(downloadedFile),
      cancel: jest.fn(),
    });

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'needsInstallPermission' });
    expect(mockInstallApk).not.toHaveBeenCalled();
  });

  it('a download failure reports failed(download) and never reaches verifyApk', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn().mockRejectedValue(new Error('network down')),
      cancel: jest.fn(),
    });

    await updateFlow.start(release());

    expect(updateFlow.getSnapshot()).toEqual({ step: 'failed', reason: 'download' });
    expect(mockVerifyApk).not.toHaveBeenCalled();
  });

  it('a second start() call while already active is a no-op, not a second download', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    let resolveDownload: (f: MockFile) => void = () => {};
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn(() => new Promise((resolve) => (resolveDownload = resolve))),
      cancel: jest.fn(),
    });

    const first = updateFlow.start(release());
    await Promise.resolve(); // let the first call reach 'downloading'
    await updateFlow.start(release()); // second call while active

    expect(mockReleaseDownloadUrl).toHaveBeenCalledTimes(1);
    resolveDownload(new MockFile('file:///cache/updates/TurboV4.3.0.apk'));
    mockVerifyApk.mockResolvedValue({ ok: true, versionName: '4.3.0', versionCode: 43 });
    await first;
  });

  it('getActiveRelease keeps returning the release actually running once start() has been called', async () => {
    mockReleaseDownloadUrl.mockResolvedValue({ url: 'https://signed.example/apk' });
    let resolveDownload: (f: MockFile) => void = () => {};
    (MockFile.createDownloadTask as jest.Mock).mockReturnValue({
      downloadAsync: jest.fn(() => new Promise((resolve) => (resolveDownload = resolve))),
      cancel: jest.fn(),
    });

    const running = release({ version: '4.3.0', assetName: 'TurboV4.3.0.apk' });
    const flowPromise = updateFlow.start(running);
    await Promise.resolve(); // let it reach 'downloading'

    // The scenario the review flagged: a manual "Check for updates" elsewhere (or any
    // other refetch) can return a *different* release, or null, into the shared query
    // cache while this flow is still running. UpdateBanner/UpdateModal must not follow
    // that — they read getActiveRelease() instead of the query whenever the flow isn't
    // idle, so the UI keeps tracking the release actually being installed.
    expect(updateFlow.getActiveRelease()).toEqual(running);
    expect(updateFlow.getSnapshot().step).toBe('downloading');

    mockVerifyApk.mockResolvedValue({ ok: true, versionName: '4.3.0', versionCode: 43 });
    resolveDownload(new MockFile('file:///cache/updates/TurboV4.3.0.apk'));
    await flowPromise;

    // Still the same release all the way through to 'installing' — a later query
    // refetch never gets consulted mid-flow, only at 'idle'.
    expect(updateFlow.getSnapshot().step).toBe('installing');
    expect(updateFlow.getActiveRelease()).toEqual(running);
  });
});
