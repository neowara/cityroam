import { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Download, X } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { useAppForegroundEffect, useForegroundReturnEffect } from '@/lib/useAppForeground';
import { formatDateTime } from '@/lib/dateFormat';
import {
  currentAppVersion,
  dismissVersion,
  getDismissedVersion,
  shouldShowBanner,
  updateFlow,
  updateModalVisibility,
  useAppUpdate,
  type UpdateFailureReason,
  type UpdateFlowState,
} from '@/features/updates/appUpdate';
import type { LatestRelease } from '@/lib/api';

const FAILURE_COPY: Record<UpdateFailureReason, string> = {
  unverifiable: "This release can't be verified. Try again later.",
  download: 'The download failed. Check your connection and try again.',
  fileMismatch: "The downloaded file didn't match the release. Try again.",
  signatureMismatch: "The downloaded file's signature didn't match. Try again.",
  storage: "There isn't enough storage on this device for the update.",
  blocked: 'The device blocked the install. Try again.',
  cancelled: 'Install was cancelled.',
};

function sizeMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** The banner's single-line label for every step but 'idle' — same "keep the rider
 * informed, never a silent wait" rule D2 applies to the modal, extended to the banner
 * that's now the only thing surfacing progress once the modal itself is closed. */
function bannerInProgressLabel(state: Exclude<UpdateFlowState, { step: 'idle' }>): string {
  switch (state.step) {
    case 'blockedByRide':
      return 'Finish your ride to update';
    case 'resolvingUrl':
      return 'Preparing to download…';
    case 'downloading':
      return `Downloading ${state.totalBytes > 0 ? Math.round((state.bytesWritten / state.totalBytes) * 100) : 0}%`;
    case 'verifying':
      return 'Checking the download…';
    case 'needsInstallPermission':
      return 'Needs permission to install';
    case 'installing':
      return 'Installing…';
    case 'pendingUserAction':
      return 'Confirm the install';
    case 'failed':
      return 'Update failed. Tap to retry.';
    case 'success':
      return 'Installing the update';
  }
}

/** Renders `- ` lines as bullets, everything else as a plain paragraph line — the
 * release body is a markdown bullet-list changelog (release-full.ps1's own format),
 * not full markdown, so this is deliberately just that one transform. */
function ReleaseNotes({ notes, color }: { notes: string; color: string }) {
  const lines = notes.split('\n').filter((l) => l.trim().length > 0);
  return (
    <View style={styles.notes}>
      {lines.map((line, i) => {
        const bullet = line.trim().startsWith('- ');
        return (
          <Text key={i} style={[styles.noteLine, { color }]}>
            {bullet ? `•  ${line.trim().slice(2)}` : line.trim()}
          </Text>
        );
      })}
    </View>
  );
}

/**
 * Dashboard/login update banner pill — rendered directly below `<ReadinessBanner />` on
 * the dashboard (nothing renders above the wordmark) and above the form on the login
 * screen, because a rider stuck on a broken login must still be able to see and install
 * the fix.
 *
 * Only visible when a genuinely newer, non-dismissed release exists — no placeholder or
 * spinner while checking, and nothing on a check error (useAppUpdate already swallows
 * those). Tapping it opens the single shared `<UpdateModal>` (see that component's own
 * doc comment for why it's mounted once at the app root, not duplicated here) — showing
 * live download progress instead of the "available" screen if a background download is
 * already under way, since `updateFlow` is module-scope state that survives navigation.
 */
export function UpdateBanner() {
  const { data: queryRelease } = useAppUpdate();
  const flowState = useSyncExternalStore(updateFlow.subscribe, updateFlow.getSnapshot);
  // Once the flow is actually running, it's the source of truth for which release is
  // in play — not the shared query cache, which a manual "Check for updates" from
  // Settings can overwrite (a different release, or null on a transient miss) while
  // this flow is still mid-download/verify/install. See getActiveRelease's own doc
  // comment for why this can't just always read the query.
  const release = flowState.step === 'idle' ? queryRelease : (updateFlow.getActiveRelease() ?? queryRelease);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const { accentColor } = useAppTheme();
  const surface = useThemeColor({}, 'surface');
  const inkDim = useThemeColor({}, 'inkDim');

  useEffect(() => {
    void getDismissedVersion().then(setDismissedVersion);
  }, []);

  const currentVersion = currentAppVersion();
  const showBanner = !!release && !!currentVersion && shouldShowBanner(release.version, currentVersion, dismissedVersion);

  if (!showBanner || !release) return null;

  const idle = flowState.step === 'idle';

  return (
    <PressableScale
      style={[styles.banner, { borderColor: accentColor + '55', backgroundColor: surface }]}
      onPress={() => updateModalVisibility.open()}>
      <Download size={16} color={accentColor} />
      <View style={styles.bannerText}>
        <Text style={[styles.bannerTitle, { color: accentColor }]}>
          {idle ? `Cityroam ${release.version} is available` : bannerInProgressLabel(flowState)}
        </Text>
        {idle && <Text style={[styles.bannerSubtitle, { color: inkDim }]}>Tap to see what's new</Text>}
      </View>
      {idle && (
        // Only shown at the 'idle' step — once the flow has actually started, the
        // banner is the rider's only visibility into it (verifyApk/install keep
        // running in lib/appUpdate.ts's module scope regardless of whether this
        // component is even mounted), so dismissing it here would strand a flow that
        // might still need the rider's attention (needsInstallPermission, a failure)
        // with no way back to it.
        <PressableScale
          hitSlop={8}
          onPress={(e) => {
            e.stopPropagation?.();
            void dismissVersion(release.version).then(() => setDismissedVersion(release.version));
          }}>
          <X size={16} color={inkDim} />
        </PressableScale>
      )}
    </PressableScale>
  );
}

/**
 * The single shared update modal — mounted once at the app root (`app/_layout.tsx`),
 * never per-screen. `<UpdateBanner>` (dashboard, login) and Settings' "Check for
 * updates" row all just call `updateModalVisibility.open()`; this is the only component
 * that ever renders the actual `<AppModal>`. Duplicating an `<AppModal>` per call site
 * bound to the same shared visibility flag would let two real native `Modal`s end up
 * visible at once whenever two of those screens stay mounted together (this app's tab
 * navigator doesn't unmount inactive tabs) — exactly the confirmed Android perf problem
 * AGENTS.md's modal-stacking rule exists for, just reached through a different path
 * than the "sub-picker inside an open modal" case that rule was originally written for.
 *
 * Reads `release` from the same `useAppUpdate()` query cache every caller shares while
 * the flow is idle, so a manual check from Settings (which seeds that cache via
 * `useManualAppUpdateCheck`) shows up here correctly without this component needing its
 * own copy of the data. Once the flow is actually running, `updateFlow.getActiveRelease()`
 * takes over instead — see its own doc comment for why: that same manual check must
 * never be able to make this modal (or the banner) disappear out from under a flow
 * that's mid-download/verify/install and still needs the rider's attention.
 */
export function UpdateModal() {
  const { data: queryRelease } = useAppUpdate();
  const flowState = useSyncExternalStore(updateFlow.subscribe, updateFlow.getSnapshot);
  const release = flowState.step === 'idle' ? queryRelease : (updateFlow.getActiveRelease() ?? queryRelease);
  const visible = useSyncExternalStore(updateModalVisibility.subscribe, updateModalVisibility.getSnapshot);
  const { accentColor } = useAppTheme();
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');

  // Re-check "Install unknown apps" the moment the rider returns from the settings
  // screen this modal sent them to (fires on mount too, which is a harmless no-op
  // unless the flow happens to already be sitting in needsInstallPermission).
  useAppForegroundEffect(() => updateFlow.recheckInstallPermission());
  // Distinct from the effect above: only a genuine return (never on mount) counts as
  // "the rider dismissed the system install dialog without finishing it" — see
  // updateFlow.onForegroundReturn's own doc comment.
  useForegroundReturnEffect(() => updateFlow.onForegroundReturn());

  if (!release) return null;

  return (
    <AppModal visible={visible} onRequestClose={() => updateModalVisibility.close()}>
      <UpdateModalBody
        release={release}
        flowState={flowState}
        onClose={() => updateModalVisibility.close()}
        accentColor={accentColor}
        inkDim={inkDim}
        crit={crit}
      />
    </AppModal>
  );
}

/** The per-step content `<UpdateModal>` renders inside its `AppModal` — split out as its
 * own component only so the step switch isn't buried inside UpdateModal's own body. */
export function UpdateModalBody({
  release,
  flowState,
  onClose,
  accentColor,
  inkDim,
  crit,
}: {
  release: LatestRelease;
  flowState: UpdateFlowState;
  onClose: () => void;
  accentColor: string;
  inkDim: string;
  crit: string;
}) {
  switch (flowState.step) {
    case 'idle':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Cityroam {release.version}</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>
            {formatDateTime(release.publishedAt)} · {sizeMb(release.sizeBytes)} MB
          </Text>
          <ScrollView style={styles.notesScroll}>
            <ReleaseNotes notes={release.notes} color={inkDim} />
          </ScrollView>
          <PressableScale style={[styles.primaryButton, { backgroundColor: accentColor }]} onPress={() => void updateFlow.start(release)}>
            <Text style={styles.primaryButtonText}>Download and install</Text>
          </PressableScale>
          <PressableScale style={styles.secondaryButton} onPress={onClose}>
            <Text style={[styles.secondaryButtonText, { color: inkDim }]}>Later</Text>
          </PressableScale>
        </View>
      );

    case 'blockedByRide':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Finish your ride first</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>Updating restarts the app.</Text>
          <PressableScale
            style={[styles.primaryButton, { backgroundColor: accentColor }]}
            onPress={() => {
              updateFlow.reset();
              onClose();
            }}>
            <Text style={styles.primaryButtonText}>OK</Text>
          </PressableScale>
        </View>
      );

    case 'resolvingUrl':
    case 'downloading': {
      const pct = flowState.step === 'downloading' && flowState.totalBytes > 0 ? flowState.bytesWritten / flowState.totalBytes : 0;
      const writtenMb = flowState.step === 'downloading' ? sizeMb(flowState.bytesWritten) : '0.0';
      const totalMb =
        flowState.step === 'downloading' && flowState.totalBytes > 0 ? sizeMb(flowState.totalBytes) : sizeMb(release.sizeBytes);
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Downloading {release.version}</Text>
          <View style={[styles.progressTrack, { backgroundColor: inkDim + '33' }]}>
            <View style={[styles.progressFill, { backgroundColor: accentColor, width: `${Math.round(pct * 100)}%` }]} />
          </View>
          <Text style={[styles.subtitle, { color: inkDim }]}>
            {writtenMb} / {totalMb} MB
          </Text>
          <PressableScale style={styles.secondaryButton} onPress={() => updateFlow.cancelDownload()}>
            <Text style={[styles.secondaryButtonText, { color: inkDim }]}>Cancel</Text>
          </PressableScale>
        </View>
      );
    }

    case 'verifying':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Checking the download</Text>
        </View>
      );

    case 'needsInstallPermission':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Allow Cityroam to install updates</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>
            Android will open a settings page. Turn on Allow from this source, then come back.
          </Text>
          <PressableScale
            style={[styles.primaryButton, { backgroundColor: accentColor }]}
            onPress={() => void updateFlow.openInstallPermissionSettings()}>
            <Text style={styles.primaryButtonText}>Open settings</Text>
          </PressableScale>
        </View>
      );

    case 'installing':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Installing</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>Cityroam will close and reopen on the new version.</Text>
        </View>
      );

    case 'pendingUserAction':
      // No action here on purpose — the system's own install-confirmation dialog is
      // genuinely on top right now. "Try again" only makes sense once it's actually
      // been dismissed, which is exactly when the flow moves to the 'failed'
      // ('cancelled') case below (see onForegroundReturn's own doc comment); showing
      // a "Try again" button here that's a no-op until then would be confusing rather
      // than useful.
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Confirm the install</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>Android's own install screen is on top.</Text>
        </View>
      );

    case 'failed':
      return (
        <View style={styles.body}>
          <Text style={[styles.title, { color: crit }]}>Update failed</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>{FAILURE_COPY[flowState.reason]}</Text>
          <PressableScale style={[styles.primaryButton, { backgroundColor: accentColor }]} onPress={() => void updateFlow.retry()}>
            <Text style={styles.primaryButtonText}>Try again</Text>
          </PressableScale>
          <PressableScale
            style={styles.secondaryButton}
            onPress={() => {
              updateFlow.reset();
              onClose();
            }}>
            <Text style={[styles.secondaryButtonText, { color: inkDim }]}>Close</Text>
          </PressableScale>
        </View>
      );

    case 'success':
      return (
        <View style={styles.body}>
          <Text style={styles.title}>Installing the update</Text>
          <Text style={[styles.subtitle, { color: inkDim }]}>Cityroam will close and reopen on the new version any moment now.</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  bannerText: { flex: 1 },
  bannerTitle: { fontSize: 13, fontWeight: '700' },
  bannerSubtitle: { fontSize: 11.5, marginTop: 1 },
  body: { alignItems: 'center', gap: 8, alignSelf: 'stretch' },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  notesScroll: { maxHeight: 160, alignSelf: 'stretch' },
  notes: { gap: 4, paddingVertical: 4 },
  noteLine: { fontSize: 13, lineHeight: 19 },
  primaryButton: { alignSelf: 'stretch', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 8 },
  primaryButtonText: { color: '#fff', fontWeight: '600' },
  secondaryButton: { alignSelf: 'stretch', padding: 10, alignItems: 'center' },
  secondaryButtonText: { fontWeight: '600' },
  progressTrack: { alignSelf: 'stretch', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 4 },
  progressFill: { height: '100%', borderRadius: 4 },
});
