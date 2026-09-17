import { NativeModule, requireNativeModule } from 'expo';

/**
 * NAVEE scooter link. The session half deliberately mirrors BoardBle (same `onDirect*`
 * events, same connect/reconnect/phase calls) so lib/deviceLink drives both brands
 * through one path; see lib/deviceLink/transport.ts.
 */

export type NaveeCaptcha = {
  /** PNG/JPEG bytes as base64, without a data-URI prefix. */
  imageBase64: string;
  uuid: string;
};

export type NaveeAccountVehicle = {
  /** The account's id for the scooter; also printed in its Bluetooth advertisement. */
  mac: string;
  name: string | null;
  carNo: string | null;
  productId: string | null;
  /** Non-zero when the scooter is shared with this account: the owner's account id. */
  shareUserId: number;
};

export type NaveeScanResult = {
  address: string;
  name: string | null;
  rssi: number;
  cloudMac: string | null;
  productId: number | null;
  addressType: number;
};

export type NaveeFrameEvent = { devId: string; cmd: number; status: number; hex: string; at: number };

export type NaveeAuthResultEvent = { devId: string; ok: boolean; status: number | null; message: string };

type NaveeBleEvents = {
  onDirectDpUpdate: (event: { devId: string; dps: Record<string, number | boolean | string> }) => void;
  onDirectConnectionChanged: (event: { devId: string; connected: boolean; willRetry?: boolean }) => void;
  onDirectStep: (event: { devId: string; message: string }) => void;
  onDirectAddressDiscovered: (event: { devId: string; address: string; addressType: number }) => void;
  /** Every frame the scooter sends — for the on-device protocol session. */
  onNaveeFrame: (event: NaveeFrameEvent) => void;
  /** Auth outcome of each connect attempt. */
  onNaveeAuthResult: (event: NaveeAuthResultEvent) => void;
  onScanResult: (event: NaveeScanResult) => void;
};

declare class NaveeBleModule extends NativeModule<NaveeBleEvents> {
  /** An image code the NAVEE login needs. */
  captcha(): Promise<NaveeCaptcha>;
  /** Signs in to the NAVEE account the scooter is bound to. The password is used for this call only. */
  signIn(email: string, password: string, captchaCode: string, captchaUuid: string): Promise<{ userId: number }>;
  listVehicles(): Promise<NaveeAccountVehicle[]>;
  isSignedIn(): boolean;
  signedInUserId(): number | null;
  signOut(): void;

  /** Reports nearby NAVEE scooters via onScanResult; resolves when the scan ends. */
  scan(timeoutMs: number): Promise<null>;
  stopScan(): void;

  /** Starts (or adopts) the persistent session. `accountId` is what the scooter's auth checks. */
  connectDirect(
    devId: string,
    cloudMac: string | null,
    address: string | null,
    addressType: number | null,
    accountId: number,
    bindFlag: number,
  ): void;
  disconnectDirect(devId: string): void;
  reconnectNow(devId: string): void;
  /** 'idle' | 'scanning' | 'connecting' | 'handshaking' | 'connected' | 'backoff', or null. */
  connectionPhase(devId: string): string | null;
  isDirectConnected(devId: string): boolean;
  recentDiagnostics(): string[];
  startBackgroundReconnect(): void;
  stopBackgroundReconnect(): void;
  /** Asks for the settings frame; values arrive via onDirectDpUpdate. */
  queryDpsDirect(devId: string): Promise<null>;
  /** Changes one setting (see lib/navee/settings.ts for keys and values) and waits for the ack. */
  writeSetting(devId: string, key: string, value: number): Promise<null>;
}

export default requireNativeModule<NaveeBleModule>('NaveeBle');
