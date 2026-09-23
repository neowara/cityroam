import { NativeModule, requireNativeModule } from 'expo';

/** Mirrors RideJournal.kt's RideRow, JS-shaped. `state` is 'open' | 'finished' |
 * 'uploaded'. */
export type NativeRide = {
  id: number;
  /** The board the service recorded this ride from. Null for rides journaled before it
   * was stored. */
  devId: string | null;
  startMs: number;
  endMs: number | null;
  state: 'open' | 'finished' | 'uploaded';
  wasManual: boolean;
  odoStartKm: number | null;
  odoEndKm: number | null;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  distanceKm: number | null;
  maxSpeedKmh: number | null;
  endReason: string | null;
  backendId: number | null;
};

export type NativeGpsPoint = {
  tMs: number;
  lat: number;
  lon: number;
  accM: number | null;
  speedMs: number | null;
  bearing: number | null;
  altM: number | null;
};
export type NativeBoardSample = {
  tMs: number;
  speedKmh: number | null;
  batteryPct: number | null;
  voltageV: number | null;
  mode: string | null;
  odoKm: number | null;
  rideTimeOnceS: number | null;
  mileageOnceKm: number | null;
};
export type NativeRideEvent = { tMs: number; kind: string; detail: string | null };
export type NativeRideSamples = { gps: NativeGpsPoint[]; board: NativeBoardSample[]; events: NativeRideEvent[] };

/**
 * JS bridge to the native ride journal — read-only, since the journal is written
 * exclusively by RideService off the BLE/GPS callbacks. See RideService.kt's own doc
 * comment for the current scope: a durable, independent capture backstop and, since
 * ADR 0006, the app's route source — not the app's save/upload pipeline,
 * which stays JS-owned (lib/tripRecorder.ts).
 */
declare class RideCoreModule extends NativeModule<Record<string, never>> {
  /** Starts (or no-ops if already running) the native ride-recording foreground
   * service. Never stopped/started in response to board connection or ride state
   * (ADR 0004's rule) — call once from a visible moment (app foreground, board
   * paired), same as the existing board connection service. */
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** True while RideService is in the foreground with the location service type. */
  hasLocationForeground(): boolean;
  getStitchWindowMs(): number;
  setStitchWindowMs(ms: number): void;
  getActiveRide(): NativeRide | null;
  /** Newest sample timestamp of any kind for a ride, or null when nothing was ever
   * recorded against it. Distinguishes a ride genuinely underway from an open row
   * nothing has written to in a long time — see RideJournal.lastActivityMs. */
  getRideLastActivityMs(rideId: number): number | null;
  /** Finished-but-not-yet-uploaded rides, oldest first. */
  listFinishedRides(): NativeRide[];
  getRide(rideId: number): NativeRide | null;
  getRideSamples(rideId: number): NativeRideSamples;
  markRideUploaded(rideId: number, backendId: number | null): void;
}

export default requireNativeModule<RideCoreModule>('RideCore');
