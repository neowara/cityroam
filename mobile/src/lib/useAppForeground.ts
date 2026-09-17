import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/** Shared "always call the latest callback" ref, factored out so only one hook body
 * carries the react-hooks/refs lint warning for updating a ref during render — see
 * useAppForegroundEffect and useForegroundReturnEffect below, which differ only in
 * whether the callback also fires once immediately (on mount). */
function useLatestCallback(callback: () => void) {
  const ref = useRef(callback);
  ref.current = callback;
  return ref;
}

/**
 * Runs `callback` whenever the app comes back to the foreground — used to re-check
 * permission status after the user returns from a system Settings page we sent them
 * to, without requiring a manual refresh. Also runs once on mount.
 */
export function useAppForegroundEffect(callback: () => void) {
  const savedCallback = useLatestCallback(callback);

  useEffect(() => {
    savedCallback.current();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') savedCallback.current();
    });
    return () => sub.remove();
  }, [savedCallback]);
}

/**
 * Same as useAppForegroundEffect, but never fires on mount — only on a genuine
 * background-to-foreground transition afterward.
 *
 * kickReconnectOnForeground() (deviceLink) restarts the native
 * BLE client's connect cycle, which is exactly right for interrupting a stale
 * exponential backoff after the rider pulls the phone back out — but naively listening
 * for `AppState` reporting 'active' also fires at cold start: `AppState.currentState`
 * is already 'active' by the time this effect runs, and Android's `AppState` bridge
 * still delivers a synthetic 'change' event to the same value shortly after a listener
 * subscribes. That raced the app's very first, already-in-flight connect attempt and
 * tore down a handshake that had just succeeded a moment earlier — twice:
 * "handshake succeeded" immediately followed by "connection state out of sync — native
 * says disconnected" within ~150ms of app start, no real foreground transition in
 * between either time (2641ae0 tried to fix this by not firing on mount, but the
 * synthetic post-mount event isn't a mount-time call — it comes from the listener
 * itself, so that fix didn't close it). There is no stale backoff to interrupt yet at
 * cold start — the natural connect flow already owns that.
 *
 * Fixed by tracking the previously-seen state and only firing when it was genuinely
 * something other than 'active' — i.e. an actual return from the background, not
 * whatever `AppState` happens to report right after subscribing.
 */
export function useForegroundReturnEffect(callback: () => void) {
  const savedCallback = useLatestCallback(callback);
  const previousState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const wasActive = previousState.current === 'active';
      previousState.current = state;
      if (state === 'active' && !wasActive) savedCallback.current();
    });
    return () => sub.remove();
  }, [savedCallback]);
}

/**
 * Live boolean version of the same AppState concern above, for callers that need to
 * react continuously (e.g. stopping a decorative animation while backgrounded) rather
 * than run a one-off callback on return (pulled out once a second call
 * site needed this shape instead of duplicating its own AppState listener).
 */
export function useIsAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}
