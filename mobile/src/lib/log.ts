import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { AppState, Platform } from 'react-native';

import { api } from '@/lib/api';
import { clearLiveLog, pushLiveLine } from '@/lib/liveLogTail';

/** Persistent, on-device log, since console/logcat only work while plugged into a
 * computer. Survives to be read after a ride (Settings > "Share debug log"); also
 * POSTed to /api/v1/logs best-effort when reachable.
 *
 * The live in-memory ring-buffer tail used by the in-app debug console lives in
 * lib/liveLogTail.ts — split out since it shares no machinery with the durable
 * file/remote-POST responsibility here, only being called from the same `logEvent`
 * body below. */
const LOG_FILE = new File(Paths.document, 'turbo-debug.log');

function ensureFile() {
  if (!LOG_FILE.exists) {
    LOG_FILE.create();
  }
}

export type LogLine = { deviceTime: string; tag: string; message: string; data?: unknown };

export function logEvent(tag: string, message: string, data?: unknown): void {
  const deviceTime = new Date().toISOString();
  const line = `${deviceTime} [${tag}] ${message}${data !== undefined ? ' ' + safeStringify(data) : ''}\n`;
  console.log(line.trim());
  pushLiveLine({ deviceTime, tag, message, data });
  try {
    ensureFile();
    LOG_FILE.write(line, { append: true } as any);
  } catch (err) {
    console.error('[log] failed to write debug log', err);
  }
  enqueueRemote({ deviceTime, tag, message, data });
}

// Every log line used to fire its own fire-and-forget POST the instant it was written —
// during a ride, the board pushes telemetry several times a second, so that was several
// requests a second to production for the whole ride, each with no way to actually
// cancel it once the app backgrounds (React Native's fetch AbortController still fires,
// but the request itself has already left the device). Buffered here instead: at most
// one request in flight, drained a line at a time, flushed on a real signal (app
// foreground return, a caller finishing something log-worthy like a ride) rather than
// on every single line.
const REMOTE_QUEUE_CAP = 500;
// Also flushes opportunistically once this many lines have queued up, so a long
// foregrounded session doesn't just sit accumulating until the next AppState transition.
const REMOTE_FLUSH_BATCH_TRIGGER = 20;
let pendingRemote: LogLine[] = [];
let remoteFlushInFlight = false;

function enqueueRemote(line: LogLine): void {
  pendingRemote.push(line);
  if (pendingRemote.length > REMOTE_QUEUE_CAP) pendingRemote.shift(); // oldest dropped, not newest
  if (pendingRemote.length >= REMOTE_FLUSH_BATCH_TRIGGER) void flushRemoteLog();
}

/** Drains the queued remote log lines, one request at a time. A concurrent call joins
 * the in-flight drain rather than starting a second one. Stops (leaving the rest queued
 * for the next flush) the moment a POST fails — server down / no network mid-ride is
 * exactly when retrying immediately, request after request, would just add load to a
 * connection that's already struggling; the local file already has every line
 * regardless, so nothing here is a durability mechanism, only a batching one. */
export async function flushRemoteLog(): Promise<void> {
  if (remoteFlushInFlight) return;
  remoteFlushInFlight = true;
  try {
    while (pendingRemote.length > 0) {
      const line = pendingRemote[0];
      try {
        // Swallows ApiNotConfiguredError when no server is set — the local file is the record then.
        await api.postLog({
          deviceTime: line.deviceTime,
          tag: line.tag,
          message: line.message,
          data: line.data !== undefined ? safeStringify(line.data) : undefined,
        });
        pendingRemote.shift();
      } catch {
        break;
      }
    }
  } finally {
    remoteFlushInFlight = false;
  }
}

if (AppState.currentState === 'active') void flushRemoteLog();
AppState.addEventListener('change', (state) => {
  if (state === 'active') void flushRemoteLog();
});

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function readLog(): string {
  try {
    ensureFile();
    return LOG_FILE.textSync();
  } catch (err) {
    return `(failed to read log: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function clearLog(): void {
  try {
    if (LOG_FILE.exists) LOG_FILE.delete();
  } catch {
    // best-effort
  }
  clearLiveLog();
}

export function logFilePath(): string {
  return LOG_FILE.uri;
}

/**
 * Identity of the build that wrote the lines below it.
 *
 * The log file survives a reinstall, so a session from an older build sits directly
 * above one from a newer build with nothing to tell them apart. That cost real
 * debugging time: a log was read as evidence that a fix had not worked when it was
 * simply written before the fix existed. Every launch now says which build it is, and
 * a version change is called out explicitly.
 */
const LAST_VERSION_KEY = 'turbo.lastLoggedAppVersion';

export function appBuildInfo(): Record<string, unknown> {
  const config = Constants.expoConfig;
  return {
    version: config?.version ?? 'unknown',
    versionCode: config?.android?.versionCode ?? null,
    // A dev build runs JS from Metro, so its native side and its JS can be from
    // different commits — worth knowing before trusting a log.
    dev: __DEV__,
    runtime: Constants.executionEnvironment ?? 'unknown',
    android: Platform.OS === 'android' ? Number(Platform.Version) : null,
  };
}

/** Call once at launch, before anything else logs. */
export async function logAppStart(): Promise<void> {
  // Before the banner, so the trim can never cut the banner off the run it belongs to.
  trimLogIfLarge();
  const info = appBuildInfo();
  logEvent('app', '——— app start ———', info);
  try {
    const previous = await AsyncStorage.getItem(LAST_VERSION_KEY);
    const current = `${info.version}+${info.versionCode}`;
    if (previous && previous !== current) {
      logEvent('app', `build changed: ${previous} -> ${current} — lines above this are from the older build`);
    }
    if (previous !== current) await AsyncStorage.setItem(LAST_VERSION_KEY, current);
  } catch {
    // The banner above is the part that matters; the comparison is a nicety.
  }
}

/**
 * Writes a shareable copy of the log with a diagnostics header on top, and returns its
 * path. The live log is append-only, so the header goes on a copy rather than being
 * injected into the file every session.
 */
export const APP_START_MARKER = '——— app start ———';

export function exportLogForSharing(): string {
  const info = appBuildInfo();

  // The current run plus the one before it. A rider who hits something worth sharing
  // almost always reopens the app before sharing — the event itself (an odd ride, a
  // setting that "didn't work") happened in the run that just ended, so keeping only
  // "the current run" left every relevant line off the export and kept only the
  // reopen itself (: a real report's export held nothing but the
  // relaunch, while the whole incident sat in the run right before it). The file is
  // chronological and unbounded, so anything further back than that is still dropped —
  // the newest two runs are the ones worth reading, and clearly labeled so it's obvious
  // where one ends and the next begins.
  const lines = readLog().split('\n');
  const startIndices = lines.reduce<number[]>((acc, line, i) => {
    if (line.includes(APP_START_MARKER)) acc.push(i);
    return acc;
  }, []);
  const cutIndex = startIndices.length >= 2 ? startIndices[startIndices.length - 2] : (startIndices[0] ?? 0);
  const kept = cutIndex > 0 ? lines.slice(cutIndex) : lines;
  const omitted = cutIndex > 0 ? cutIndex : 0;
  const runsKept = Math.min(startIndices.length, 2);

  const header = [
    '=== Turbo debug log ===',
    `exported:    ${new Date().toISOString()}`,
    `app version: ${info.version} (versionCode ${info.versionCode})`,
    `build type:  ${info.dev ? 'development (JS from Metro)' : 'release'}`,
    `runtime:     ${info.runtime}`,
    `platform:    ${Platform.OS} ${info.android ?? ''}`.trim(),
    omitted > 0
      ? `scope:       last ${runsKept} app run(s) (${omitted} earlier line(s) from older runs omitted)`
      : 'scope:       whole log — this is the first run recorded',
    '=======================',
    '',
  ].join('\n');

  const target = new File(Paths.cache, 'turbo-debug-export.log');
  try {
    if (target.exists) target.delete();
    target.create();
    target.write(header + kept.join('\n'));
    return target.uri;
  } catch {
    // Better to share the log without a header than to fail the share outright.
    return LOG_FILE.uri;
  }
}

// Roughly two megabytes of text. The log had no bound at all, so it grew for the life
// of the install and every share carried the entire history.
const MAX_LOG_BYTES = 2_000_000;
const TRIM_TO_BYTES = 1_000_000;

/** Drops the oldest entries once the file gets large, cutting at a line boundary so no
 * entry is left half-written. Called at launch, where a one-off cost is invisible. */
export function trimLogIfLarge(): void {
  try {
    if (!LOG_FILE.exists) return;
    const size = LOG_FILE.size;
    if (size == null || size <= MAX_LOG_BYTES) return;
    const text = LOG_FILE.textSync();
    const cut = Math.max(0, text.length - TRIM_TO_BYTES);
    const from = text.indexOf('\n', cut);
    LOG_FILE.write(`(older entries trimmed — the log had grown past ${MAX_LOG_BYTES} bytes)\n${text.slice(from >= 0 ? from + 1 : cut)}`);
  } catch {
    // A log that cannot be trimmed is still a working log.
  }
}
