// SDK 56+: expo-router no longer allows importing @react-navigation/* directly in
// app code — same runtime API, re-exported from expo-router/react-navigation instead.
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import * as NavigationBar from 'expo-navigation-bar';
import 'react-native-reanimated';
import { SpaceGrotesk_300Light, SpaceGrotesk_500Medium, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { Manrope_300Light, Manrope_600SemiBold, Manrope_700Bold } from '@expo-google-fonts/manrope';

import { useColorScheme } from '@/components/useColorScheme';
import '@/features/rides/locationTask';
import '@/features/device/bleConnectionFeedback';
import '@/features/device/backgroundSelfHeal';
import '@/features/device/deviceLink/statusRefresh';
import '@/features/widget/widgetSync';
import { initAutoTracking, isFinalizeInFlight, onTripSaved, recoverInterruptedTrip, tripRecorder } from '@/features/rides/tripRecorder';
import { refreshLaunchLocation } from '@/features/rides/launchLocation';
// Also registers the home-geofence background task as a side effect (defineTask must
// run at module scope — see homeGeofence.ts's own doc comment on the task definition).
import { ensureHomeGeofenceRunning } from '@/features/rides/homeGeofence';
import { ensureNotificationPermission, setupTripNotifications } from '@/features/rides/tripNotifications';
import { useTripNotificationTaps } from '@/features/rides/useTripNotificationTaps';
import { resolveTripDeviceId } from '@/features/rides/tripDevice';
import { useAppForegroundEffect, useForegroundReturnEffect } from '@/lib/useAppForeground';
import { getAutoTrackingEnabled } from '@/lib/settings';
import { cleanUpInstalledApkFromCache } from '@/features/updates/appUpdate';
import { UpdateModal } from '@/features/updates/components/UpdateBanner';
import { invalidateRangeEstimate, invalidateTrips } from '@/lib/queries';
import { logAppStart, logEvent } from '@/lib/log';
import { syncUnsyncedTrips } from '@/features/rides/tripSync';
import { syncNativeRides } from '@/features/rides/rideCoreSync';
import { ThemeProvider as AppThemeProvider } from '@/lib/theme';
import { kickReconnectOnForeground, reconcileConnectionState } from '@/features/device/deviceLink';
import { useHeadlightBlinkHaptic } from '@/features/device/boardQuickControls';
import { revalidateSession, useSession } from '@/features/auth/auth';
import { tripsApi } from '@/lib/api/trips';
import {
  captureLastRide,
  getLastRide,
  lastRideFromTrip,
  loadWidgetContext,
  reconcileLastRideWithBackend,
} from '@/features/widget/widgetLastRide';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../../assets/fonts/SpaceMono-Regular.ttf'),
    SpaceGrotesk_300Light,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_700Bold,
    Manrope_300Light,
    Manrope_600SemiBold,
    Manrope_700Bold,
    // Brand display face, shared with cityroam-website's wordmark and this app's own
    // headers/emphasis text (lib/theme.tsx's fontStyleFor). Bundled under the ITF Free
    // Font License (assets/fonts/ClashDisplay-LICENSE.txt), which permits app embedding.
    ClashDisplay_Bold: require('../../assets/fonts/ClashDisplay-Bold.ttf'),
  });
  // Splash also waits for the session bootstrap check (stored token
  // validated against GET /auth/me) so RootLayoutNav's Stack.Protected guard never
  // renders a route decision based on a still-'loading' status.
  const { status } = useSession();

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded && status !== 'loading') {
      SplashScreen.hideAsync();
    }
  }, [loaded, status]);

  if (!loaded || status === 'loading') {
    return null;
  }

  return <RootLayoutNav />;
}

// Kicks the native client out of its exponential backoff wait on every genuine
// foreground return — a board that was powered off and back on again doesn't get
// autoConnected, and without this the reconnect could otherwise sit out however long
// the backoff had already grown to (up to 300s) before the app noticed.
//
// Deliberately useForegroundReturnEffect, not useAppForegroundEffect: this must never
// fire at cold-mount time, only on a later return from background. There is no stale
// backoff to interrupt yet at app start, and firing here raced the app's own first
// connect attempt hard enough to tear down a handshake that had just succeeded.
function BleReconnectGate() {
  useForegroundReturnEffect(() => {
    void kickReconnectOnForeground();
  });
  return null;
}

// Mounted exactly once, app-wide — see useHeadlightBlinkHaptic's own comment for why
// this can't just be called from every screen that shows headlight status.
function HeadlightBlinkHapticGate() {
  useHeadlightBlinkHaptic();
  return null;
}

// Opens the trip a "Ride saved" notification is about, once the trip screen is reachable.
function TripNotificationTapGate({ signedIn }: { signedIn: boolean }) {
  useTripNotificationTaps(signedIn);
  return null;
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const { status } = useSession();
  const signedIn = status === 'signedIn';

  // Android's edge-to-edge scrim is disabled (app.json plugin), so nav bar button contrast is set explicitly per theme instead.
  useEffect(() => {
    try {
      NavigationBar.setStyle(colorScheme === 'dark' ? 'light' : 'dark');
    } catch {}
  }, [colorScheme]);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            staleTime: 15_000, // board/trip data changes on a human timescale, not per-second
          },
        },
      }),
  );

  useEffect(() => {
    // Wires the trip-lifecycle notification subsystem — tracks app
    // First, so every line below it in the file has a named build above it.
    void logAppStart();

    // A completed self-update leaves its APK in the updates cache (kept so a failed
    // install can retry without a 65 MB download). Swept once the first screen is up,
    // since it's synchronous file work.
    requestIdleCallback(() => cleanUpInstalledApkFromCache(), { timeout: 5_000 });

    // background state (so notifications only fire when backgrounded) and requests the
    // POST_NOTIFICATIONS runtime permission (Android 13+). Fire-and-forget so the
    // permission prompt never blocks first render.
    setupTripNotifications();
    ensureNotificationPermission().catch(() => {});

    // Background reconnection is NOT started here.
    //
    // Doing so shipped a crash on launch: it brings up a connectedDevice foreground
    // service, which Android refuses — by throwing — when BLUETOOTH_CONNECT has not
    // been granted yet, which on a fresh install is always. The refusal is now caught
    // in three places, but the lesson stands: app startup is the worst possible place
    // to first exercise a platform call that can throw, because the cost of being
    // wrong is the whole app rather than one feature.
    //
    // It is applied from the settings toggle and after a successful connect instead —
    // both points where Bluetooth permission is already known to be granted and the
    // app is demonstrably in the foreground.

    // Takes the single one-shot GPS fix at app launch and caches it so the trip
    // planner / map views show the rider's position instantly without each screen
    // firing its own getCurrentPositionAsync (and without running a continuous GPS
    // watch while idle). Fire-and-forget; the fix lands in the shared cache and
    // subscribers (planner) are notified when it arrives.
    refreshLaunchLocation().catch(() => {});

    // Fire-and-forget so permission prompts don't block first render. recoverInterruptedTrip
    // runs first, unconditionally, so it finalizes any checkpointed trip before a fresh auto-detect starts.
    recoverInterruptedTrip()
      .catch((err) =>
        // Only the error message is logged, never the raw error (could carry auth headers/device ids).
        logEvent('app-startup', 'recoverInterruptedTrip failed', { error: err instanceof Error ? err.message : String(err) }),
      )
      .then(() => getAutoTrackingEnabled())
      .then((enabled) => {
        if (enabled)
          initAutoTracking().catch((err) =>
            logEvent('app-startup', 'initAutoTracking failed', { error: err instanceof Error ? err.message : String(err) }),
          );
      });
    syncUnsyncedTrips().catch((err) =>
      logEvent('app-startup', 'syncUnsyncedTrips failed', { error: err instanceof Error ? err.message : String(err) }),
    );
    // Finalizes and uploads any ride the native journal recorded since the app last
    // ran — see rideCoreSync.ts's own doc comment for why this only needs to run on
    // app open, not on any background timer (the ride is already durable the moment
    // RideService recorded it; this step is upload, not capture).
    //
    // Skipped while a live finish is still in flight — same reasoning as
    // recoverInterruptedTrip's own finalizeInFlight guard: this could otherwise match
    // and finalize the exact same native ride the live path is still in the middle of
    // saving, via a different (native ride's own startMs-derived) clientTripId, which
    // wouldn't be recognized as a duplicate.
    if (!isFinalizeInFlight()) {
      syncNativeRides().catch((err) =>
        logEvent('app-startup', 'syncNativeRides failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
    // Re-asserts the home-area geofence registration if the rider previously set one —
    // mirrors ensureForegroundServiceRunning's own re-assert-at-launch pattern. No-op
    // if none is set.
    ensureHomeGeofenceRunning().catch((err) =>
      logEvent('app-startup', 'ensureHomeGeofenceRunning failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }, [queryClient]);

  // The widget's idle "last ride" is captured at trip-finalize time, so a user who
  // upgraded after the widget shipped has no cached summary and sees the placeholder
  // despite having ride history. Backfill it once from the most recent trip on the
  // backend when signed in and no local summary exists yet. Fire-and-forget; a failure
  // (offline, no trips) just leaves the placeholder until the next real ride finishes.
  //
  // Also runs for a summary that has no backend trip id: the widget's odometer, weather
  // and per-mode figures are all fetched by trip id, and its tap opens that trip — a
  // cached ride missing the id shows "–" everywhere and taps through to nothing, which
  // is indistinguishable from the widget being broken. Awaits hydration first so a
  // not-yet-loaded cache isn't mistaken for an absent one.
  useEffect(() => {
    if (!signedIn) return;
    void loadWidgetContext()
      // Confirms a cached ride that already has a tripId still actually exists on the
      // backend — catches a delete that happened out-of-band (another session, or one
      // that predates this reconciliation existing) that the missing-tripId backfill
      // below never re-checks once a tripId is set.
      .then(() => reconcileLastRideWithBackend())
      .then(async () => {
        const cached = getLastRide();
        if (cached?.tripId != null) return;
        // The active device's rides only: devices never mix.
        const deviceId = await resolveTripDeviceId();
        if (!deviceId) return;
        const trips = await tripsApi.listTrips(deviceId);
        // The backend doesn't guarantee ordering; pick the latest by end time.
        const mostRecent = trips.reduce((latest, t) => (new Date(t.endTime) > new Date(latest.endTime) ? t : latest), trips[0]);
        if (!mostRecent) return;
        // A cached ride that ends *after* the newest backend trip is a ride that hasn't
        // synced yet — adopting the backend's would quietly swap the widget to an older
        // ride. Leave it for tripSync's backfill instead.
        if (cached && cached.endEpochMs > Date.parse(mostRecent.endTime) + 60_000) return;
        // The widget's idle view deep-links to the ride's detail screen and needs its
        // own saved odometer/weather (not just the summary listTrips returns), so fetch
        // the full trip detail for the most recent ride.
        const detail = await tripsApi.getTrip(mostRecent.id);
        await captureLastRide(lastRideFromTrip(detail));
      })
      .catch((err) =>
        logEvent('app-startup', 'widget last-ride backfill failed', { error: err instanceof Error ? err.message : String(err) }),
      );
  }, [signedIn]);

  // The JS view of the connection is built from events, so a missed one leaves a
  // genuinely connected board showing as offline until something else happens to
  // correct it. Foreground return is when the rider is about to act on it.
  //
  // Deliberately useForegroundReturnEffect, not useAppForegroundEffect: at cold-mount
  // time the app's own first connect attempt is still in flight (scanning, handshake),
  // and reconciling this early can read the native client mid-handshake as
  // "disconnected", flip JS state to match, and undo a connection that was about to
  // (or had just) succeed — via the "out of sync" log line landing
  // within ~150ms of a successful handshake at app start. Nothing needs reconciling
  // before the app has ever had a live connection to fall out of sync with.
  useForegroundReturnEffect(() => {
    reconcileConnectionState();
    void revalidateSession();
  });

  // Catches a silently-dead location task on foreground return, rather than only after the ride ends. No-ops when no trip is active.
  useAppForegroundEffect(() => {
    tripRecorder
      .ensureLocationTrackingAlive()
      .catch((err) => logEvent('app', 'ensureLocationTrackingAlive failed', { error: err instanceof Error ? err.message : String(err) }));
    void tripRecorder.reconcileLocationService();

    // A finalizeTrip failure (Health Connect hiccup, a local SQLite write failure) leaves
    // the checkpoint in place *by design* for a later retry (see tripFinalize.ts), but
    // nothing else schedules that retry while the process stays alive -- without this, a
    // ride that hit that failure would stay invisible (not saved, not synced) until the
    // user force-closed and reopened the app. Retrying on every foreground return closes
    // that gap the same way ensureLocationTrackingAlive does for a dead location task.
    // Guarded to idle only — the same checkpoint row is written continuously by an active
    // ride (see tripRecorder/checkpoints.ts's writeCheckpoint), so running this while
    // `state !== 'idle'` would try to finalize the ride that's still being recorded.
    if (tripRecorder.getSnapshot().state === 'idle') {
      recoverInterruptedTrip().catch((err) =>
        logEvent('app', 'foreground recoverInterruptedTrip failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }

    // Same gap, one layer up: a trip that made it into the local queue but whose POST
    // to the backend failed (offline, server hiccup) only retried at cold app start
    // before this — background/foreground without a full force-close never gave it
    // another chance. No idle guard needed here (unlike recoverInterruptedTrip above):
    // syncing already-saved queue rows never touches the active-recording machinery.
    syncUnsyncedTrips().catch((err) =>
      logEvent('app', 'foreground syncUnsyncedTrips failed', { error: err instanceof Error ? err.message : String(err) }),
    );
    // Same finalizeInFlight guard as the cold-start call above — skips a native ride
    // the live path might still be in the middle of saving.
    if (!isFinalizeInFlight()) {
      syncNativeRides().catch((err) =>
        logEvent('app', 'foreground syncNativeRides failed', { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  });

  // Single invalidation path for both a live trip finish and crash recovery — onTripSaved fires the instant either save completes, regardless of which screen is focused.
  useEffect(() => {
    return onTripSaved(() => {
      invalidateTrips(queryClient); // every device-filtered variant at once
      invalidateRangeEstimate(queryClient);
    });
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppThemeProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack>
            {/* Stack.Protected (current expo-router SDK 57 pattern, see
                docs.expo.dev/router/advanced/authentication) instead of a manual
                redirect effect: a signed-out user can never land on any of these
                three routes by any navigation path, and guard flips resolve
                synchronously with `status`, no separate redirect render pass. */}
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              {/* Native header replaced by a custom back+icon+title row (app/trip/[id].tsx)
                  matching the rest of the app's icon+title pattern, instead of a plain
                  native bar plus a redundant custom heading underneath it. */}
              <Stack.Screen name="trip/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="device-settings" options={{ headerShown: false }} />
              <Stack.Screen name="privacy-policy" options={{ headerShown: false }} />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="login" options={{ headerShown: false }} />
            </Stack.Protected>
          </Stack>
          <BleReconnectGate />
          <TripNotificationTapGate signedIn={signedIn} />
          <HeadlightBlinkHapticGate />
          {/* Mounted once, here — not per-screen (dashboard/login banners, Settings'
              "Check for updates" row) — see UpdateModal's own doc comment for why a
              single shared instance matters (avoids two real native Modals ending up
              visible at once, since this app's tabs don't unmount when inactive). */}
          <UpdateModal />
        </ThemeProvider>
      </AppThemeProvider>
    </QueryClientProvider>
  );
}
