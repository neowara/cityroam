import * as Haptics from 'expo-haptics';

// expo-haptics already respects the system's silent-mode/haptics-disabled
// settings on its own — no extra guard logic needed here.

export function hapticConnect(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function hapticDisconnect(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// Fired the moment a quick control (lock/cruise/headlight) actually sends its write
// to the board — distinct from the press itself, which PressableScale already
// animates on its own, so this is the "yes, that really went out over BLE" tell.
export function hapticBoardControl(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

// A light, repeated tick for as long as the headlight is blinking — deliberately the
// lightest impact style ("not too heavy") since this repeats continuously rather than
// firing once per action like the others here.
export function hapticBlinkPulse(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// notificationAsync's Success/Error patterns, not impactAsync — the in-app updater's
// install outcome is a discrete "this whole multi-step thing finished, here's how" the
// way a form submit result is, not a momentary control-press tick like the impact
// haptics above.
export function hapticUpdateSuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function hapticUpdateFailure(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}
