import { createListenable } from '@/lib/listenable';

import type { LogLine } from '@/lib/log';

/** Live in-memory tail for the in-app debug console (Settings > "Debug console") --
 * separate from the persistent file in lib/log.ts, which stays the durable record.
 * Capped so a long ride can't grow this unbounded in memory; the file has no such
 * cap, only this ring buffer does. Split out of lib/log.ts (which now stays focused
 * on durable persistence + remote POST) since the two shared no machinery, only
 * being called from the same `logEvent` body.
 *
 * Uses the shared createListenable() primitive for the subscribe/notify plumbing,
 * plus a thin wrapper here: createListenable()'s notify() takes no args, but
 * subscribers need the current buffer on every change, so subscribe() below reads
 * `liveLines` itself when notified rather than passing data through notify(). */
export const MAX_LIVE_LINES = 500;
let liveLines: LogLine[] = [];
const tail = createListenable();

/** Subscribe to the live log tail — fires immediately with the current buffer, then on
 * every new pushed line. Returns an unsubscribe function. */
export function subscribeToLog(listener: (lines: LogLine[]) => void): () => void {
  const unsubscribe = tail.subscribe(() => listener(liveLines));
  listener(liveLines);
  return unsubscribe;
}

export function pushLiveLine(line: LogLine): void {
  liveLines = [...liveLines, line];
  if (liveLines.length > MAX_LIVE_LINES) liveLines = liveLines.slice(liveLines.length - MAX_LIVE_LINES);
  tail.notify();
}

export function clearLiveLog(): void {
  liveLines = [];
  tail.notify();
}
