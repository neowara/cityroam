import { NativeModule, requireNativeModule } from 'expo';

/**
 * SDK-free board link. Everything here talks to the board over plain Android BLE (no
 * Tuya SDK) and, for the sign-in half, to Tuya's mobile API with only javax.crypto
 * primitives behind it.
 */

export type TuyaMobileAccountDevice = {
  devId: string;
  uuid: string | null;
  name: string | null;
  productId: string | null;
};

export type TuyaMobileDeviceKeys = {
  devId: string;
  uuid: string | null;
  productId: string | null;
  localKey: string;
  secKey: string | null;
  /** The board's own datapoint schema as the account reports it, raw JSON, or null.
   * The SDK supplied this per device; without it the app falls back to a schema
   * compiled into the build, whose ranges have been wrong for a real board before. */
  schemaJson: string | null;
};

type BoardBleEvents = {
  /** Datapoints pushed by the board over the direct connection. */
  onDirectDpUpdate: (event: { devId: string; dps: Record<string, number | boolean | string> }) => void;
  /** Direct-connection state, including whether a reconnect is scheduled. */
  onDirectConnectionChanged: (event: { devId: string; connected: boolean; willRetry?: boolean }) => void;
  /** Human-readable connection progress — surfaced through logEvent. */
  onDirectStep: (event: { devId: string; message: string }) => void;
  /** The board's Bluetooth address, learned from a scan. Tuya's API never returns it,
   * and without it every reconnect has to scan instead of parking an autoConnect.
   * `addressType` is `BluetoothDevice.ADDRESS_TYPE_PUBLIC` (0) / `_RANDOM` (1) / other —
   * see BoardScanner.addressTypeOf's own comment (native side). */
  onDirectAddressDiscovered: (event: { devId: string; address: string; addressType: number }) => void;
};

declare class BoardBleModule extends NativeModule<BoardBleEvents> {
  /** Starts (or keeps) the persistent direct-BLE session for a paired board.
   * `addressType`: pass the last-known value from `onDirectAddressDiscovered` /
   * stored credentials once learned; null until then. */
  connectDirect(
    devId: string,
    uuid: string | null,
    address: string | null,
    localKey: string,
    secKey: string | null,
    addressType?: number | null,
  ): void;
  disconnectDirect(devId: string): void;
  /** Interrupts whatever backoff this board's client is sitting in and starts a fresh
   * connect attempt on the SAME client instance — no teardown, no replacement. See
   * connectDirect's own comment (native side) for why replacing was the bug. No-op if
   * nothing's registered for this devId, or a connect attempt is already in flight. */
  reconnectNow(devId: string): void;
  /** The client's own view of what it's doing right now: 'idle' | 'scanning' |
   * 'connecting' | 'handshaking' | 'connected' | 'backoff', or null if nothing is
   * registered for this devId. Only 'connected'/'backoff'/'idle' are settled states safe
   * to reconcile JS state against — a mid-flight phase means native hasn't decided
   * anything yet. */
  connectionPhase(devId: string): string | null;
  /** The last ~200 step lines across every client this process has run (including the
   * background service's own client before JS ever adopts it) — for the debug console /
   * exported diagnostics, not the live event stream. */
  recentDiagnostics(): string[];
  /** 'auto_connect' | 'scan_then_direct' — see BoardBleClient.IdleConnectStrategy's
   * own doc comment. Runtime-switchable, for on-device verification and the debug
   * console's Diagnostics panel. */
  getIdleConnectStrategy(): string;
  setIdleConnectStrategy(strategy: 'auto_connect' | 'scan_then_direct'): void;
  /** Keeps the board connected while the app is backgrounded or its process is killed.
   * The key material is stored natively because a process the system recreated has no
   * React runtime to read it from secure storage. */
  startBackgroundReconnect(
    devId: string,
    uuid: string | null,
    mac: string | null,
    localKey: string,
    secKey: string | null,
    addressType?: number | null,
  ): void;
  /** Stops background reconnection and forgets the natively stored key material. */
  stopBackgroundReconnect(): void;
  isDirectConnected(devId: string): boolean;
  publishDpDirect(
    devId: string,
    dpId: string,
    type: 'bool' | 'value' | 'enum' | 'string' | 'raw',
    value: boolean | number | string,
  ): Promise<null>;
  /** Asks the board to push its current values now (they arrive via onDirectDpUpdate). */
  queryDpsDirect(devId: string): Promise<null>;
  /** Signs in to the Tuya account that already owns the board. The password is used for this call only. */
  signIn(email: string, password: string, countryCode: string): Promise<{ uid: string }>;
  /** Devices in the signed-in account's home — lets the user pick their board. */
  listDevices(): Promise<TuyaMobileAccountDevice[]>;
  /** localKey + secKey for the chosen device. This is what the BLE handshake needs. */
  fetchKeys(devId: string): Promise<TuyaMobileDeviceKeys>;
  /** Whether a Tuya session is still held in native memory. It does not survive a
   * process restart, so an account call needs a fresh sign-in after one. */
  isSignedInToTuya(): boolean;
  /** Clears the native in-memory session (sid/ecode/uid) — called on sign-out. */
  signOut(): void;
}

export default requireNativeModule<BoardBleModule>('BoardBle');
