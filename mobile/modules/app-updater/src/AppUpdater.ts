import { NativeModule, requireNativeModule } from 'expo';

export type InstallStatusEvent =
  | { status: 'success' }
  | { status: 'pendingUserAction' } // the system confirm dialog was shown
  | { status: 'failure'; code: string; message: string }; // PackageInstaller.STATUS_FAILURE_* mapped to a name

export type ApkCheck =
  | { ok: true; versionName: string; versionCode: number }
  | { ok: false; reason: 'sha256Mismatch' | 'wrongPackage' | 'notNewer' | 'signatureMismatch' | 'unreadable' };

/**
 * Native self-updater: verifies a downloaded APK against the release it's supposed to
 * be, then installs it over the running app via `PackageInstaller`. This JS surface only
 * verifies and installs a file already on disk; resolving the download URL and running
 * the download itself are `src/features/updates/appUpdate.ts`'s job.
 */
declare class AppUpdaterModule extends NativeModule<{ onInstallStatus: (event: InstallStatusEvent) => void }> {
  /** Whether "Install unknown apps" is currently allowed for this app. */
  canRequestPackageInstalls(): boolean;
  /** Opens the per-app "Install unknown apps" settings page. Re-check
   * canRequestPackageInstalls() on foreground return rather than assuming the rider
   * granted it. */
  openInstallPermissionSettings(): Promise<void>;
  /** The versionCode of the app currently running — compare a candidate APK's
   * versionCode against this, not `Constants.expoConfig`'s, since the archive being
   * verified might not be readable there yet. */
  installedVersionCode(): number;
  /** Verifies a downloaded APK's SHA-256, package name, versionCode, and signing
   * certificate before it's ever handed to the installer — never throws, always
   * resolves to a tagged result. Runs off the JS/main thread natively. */
  verifyApk(fileUri: string, expectedSha256: string): Promise<ApkCheck>;
  /** Starts a `PackageInstaller` session for an already-verified APK. Resolves once the
   * session is committed, not once installation finishes — the actual outcome
   * (`success` / `pendingUserAction` / `failure`) arrives later via `onInstallStatus`. */
  installApk(fileUri: string): Promise<void>;
}

export default requireNativeModule<AppUpdaterModule>('AppUpdater');
