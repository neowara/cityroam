import { NativeModule, requireNativeModule } from 'expo';

declare class DevicePowerModule extends NativeModule<Record<never, never>> {
  isIgnoringBatteryOptimizations(): boolean;
  /** Opens the system dialog to exempt this app from battery optimization, built from
   * the real package name natively — see the native module's own comment for the bug
   * this replaces (a hardcoded pre-rename package id via expo-intent-launcher). */
  requestIgnoreBatteryOptimizations(): Promise<void>;
  isPowerSaveModeOn(): boolean;
  /** ISO 3166-1 alpha-2 from the SIM/network telephony state, or null with no SIM
   * (Wi-Fi-only device, airplane mode with no registered network). */
  networkCountryIso(): string | null;
}

export default requireNativeModule<DevicePowerModule>('DevicePower');
