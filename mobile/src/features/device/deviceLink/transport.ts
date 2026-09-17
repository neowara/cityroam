import BoardBleNative from '@modules/board-ble/src/BoardBle';
import NaveeBleNative from '@modules/navee-ble/src/NaveeBle';
import { isNaveeDevId } from '@/features/device/navee/credentials';

/**
 * Which native module serves a device. Both expose the same session surface (the
 * `onDirect*` events and connect/reconnect/phase calls), so everything above this —
 * session state, snapshots, the trip recorder — stays brand-agnostic. A NAVEE devId
 * carries the `navee-` prefix, so the choice never needs a storage read. Adding a
 * third brand means adding it to `MODULES` here, not another devId branch.
 */

type DirectSessionModule = {
  isDirectConnected(devId: string): boolean;
  connectionPhase(devId: string): string | null;
  disconnectDirect(devId: string): void;
  reconnectNow(devId: string): void;
  queryDpsDirect(devId: string): Promise<null>;
  stopBackgroundReconnect(): void;
};

const NATIVE_MODULES = [BoardBleNative, NaveeBleNative] as const;

const MODULES: readonly DirectSessionModule[] = NATIVE_MODULES;

function moduleFor(devId: string): DirectSessionModule {
  return isNaveeDevId(devId) ? NaveeBleNative : BoardBleNative;
}

type DirectEvents = {
  onDirectConnectionChanged: { devId: string; connected: boolean; willRetry?: boolean };
  onDirectDpUpdate: { devId: string; dps: Record<string, number | boolean | string> };
  onDirectAddressDiscovered: { devId: string; address: string; addressType: number };
  onDirectStep: { devId: string; message: string };
};

/** Subscribes to one session event on every brand's module; events carry their devId. */
export function addDirectListener<E extends keyof DirectEvents>(event: E, handler: (payload: DirectEvents[E]) => void): () => void {
  const subs = NATIVE_MODULES.map((m) =>
    (m.addListener as unknown as (e: E, h: (p: DirectEvents[E]) => void) => { remove(): void })(event, handler),
  );
  return () => subs.forEach((s) => s.remove());
}

export function directIsConnected(devId: string): boolean {
  return moduleFor(devId).isDirectConnected(devId);
}

export function directConnectionPhase(devId: string): string | null {
  return moduleFor(devId).connectionPhase(devId);
}

export function directDisconnect(devId: string): void {
  moduleFor(devId).disconnectDirect(devId);
}

export function directReconnectNow(devId: string): void {
  moduleFor(devId).reconnectNow(devId);
}

export function directQueryStatus(devId: string): Promise<null> {
  return moduleFor(devId).queryDpsDirect(devId);
}

/** Stops background reconnection on every brand — only one device is ever active. */
export function stopAllBackgroundReconnect(): void {
  for (const m of MODULES) {
    try {
      m.stopBackgroundReconnect();
    } catch {
      // Best-effort.
    }
  }
}
