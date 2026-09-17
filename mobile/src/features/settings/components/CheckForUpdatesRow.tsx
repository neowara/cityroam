import { useState } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { styles } from '@/features/settings/styles';
import { currentAppVersion, isNewerVersion, updateModalVisibility, useManualAppUpdateCheck } from '@/features/updates/appUpdate';
import { useAppTheme } from '@/lib/theme';

/** Checks for an update without the 6-hour throttle the banners use. A found update opens
 * the single UpdateModal mounted at the app root rather than a second modal here, since
 * tabs stay mounted and two native modals could end up visible at once. */
export function CheckForUpdatesRow() {
  const { accentColor } = useAppTheme();
  const { check } = useManualAppUpdateCheck();
  const [checking, setChecking] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);

  const runCheck = async () => {
    setChecking(true);
    setStatusText(null);
    try {
      const found = await check();
      const installed = currentAppVersion();
      if (found && installed && isNewerVersion(found.version, installed)) {
        updateModalVisibility.open();
      } else {
        setStatusText("You're on the latest version");
      }
    } catch {
      setStatusText("Couldn't check for updates right now");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Check for updates</Text>
        <PressableScale onPress={runCheck} disabled={checking}>
          <Text style={[styles.link, { color: accentColor, opacity: checking ? 0.5 : 1 }]}>{checking ? 'Checking…' : 'Check'}</Text>
        </PressableScale>
      </View>
      {statusText && <Text style={styles.note}>{statusText}</Text>}
    </>
  );
}
