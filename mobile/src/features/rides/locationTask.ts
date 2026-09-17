import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { LOCATION_TASK_NAME, tripRecorder } from '@/features/rides/tripRecorder';
import { logEvent } from '@/lib/log';

/**
 * Must run at module scope (not inside a component/hook) — TaskManager needs the task
 * defined before the app finishes loading so headless/background invocations after an
 * app restart can find it. Imported once, early, from app/_layout.tsx.
 */
TaskManager.defineTask(LOCATION_TASK_NAME, async ({ data, error }) => {
  if (error) {
    logEvent('trip', 'location task error', { error: error.message, code: (error as { code?: unknown }).code });
    return;
  }
  const { locations } = (data ?? { locations: [] }) as { locations: Location.LocationObject[] };
  // Awaited in sequence, not Promise.all — genuinely done means done, and the OS is
  // free to suspend the process the instant this task executor's promise resolves
  // (see tripRecorder.ts's handleLocationSample for the bug this fixes).
  for (const loc of locations) {
    await tripRecorder.handleLocationSample(loc, 'task');
  }
});
