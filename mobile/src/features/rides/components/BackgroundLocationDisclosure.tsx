import { StyleSheet } from 'react-native';
import { MapPin } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';

/**
 * Google Play's required prominent disclosure for background location.
 *
 * This is a compliance artifact, not decoration, and Play rejects releases that get it
 * wrong. The rules it satisfies, from Play Console's "Understanding location in the
 * background permissions" and "Best practices for prominent disclosure and consent":
 *
 * - It appears immediately before the runtime permission request, never after.
 * - It is in the app itself. A privacy policy or store listing does not count.
 * - It says "location", and says the access continues "when the app is closed or not in
 *   use" — Play looks for that phrasing specifically.
 * - It names every feature that uses background location, rather than describing the
 *   permission in the abstract.
 * - It can be declined. A dialog whose only option is to accept is not consent, and
 *   dismissing it must not fall through to the permission prompt.
 *
 * Changing this text risks the next release. If a feature starts or stops using
 * background location, the list below has to change with it.
 */
export function BackgroundLocationDisclosure({
  visible,
  onAccept,
  onDecline,
}: {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { accentColor } = useAppTheme();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const line = useThemeColor({}, 'line');

  return (
    <AppModal visible={visible} onRequestClose={onDecline} contentStyle={styles.card} showCloseButton={false}>
      <MapPin size={28} color={accentColor} />
      <Text style={[styles.title, { color: text }]}>Cityroam collects location data</Text>

      <Text style={[styles.body, { color: inkDim }]}>
        Cityroam collects location data to enable ride recording, route maps, distance and speed, and automatic start and stop when your
        board connects, even when the app is closed or not in use.
      </Text>
      <Text style={[styles.body, { color: inkDim }]}>
        Location is saved with your rides in your Cityroam account. It is never used for advertising and never sold.
      </Text>
      <Text style={[styles.body, { color: inkDim }]}>
        You can decline and still record rides with the app open, and you can turn this off later in your phone&apos;s settings.
      </Text>

      <PressableScale style={[styles.primary, { backgroundColor: accentColor }]} onPress={onAccept}>
        <Text style={styles.primaryText}>Allow</Text>
      </PressableScale>
      <PressableScale style={[styles.secondary, { borderColor: line }]} onPress={onDecline}>
        <Text style={[styles.secondaryText, { color: inkDim }]}>Not now</Text>
      </PressableScale>
    </AppModal>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', gap: 12, padding: 22 },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  primary: { alignSelf: 'stretch', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: { alignSelf: 'stretch', borderRadius: 12, borderWidth: 1, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { fontWeight: '600' },
});
