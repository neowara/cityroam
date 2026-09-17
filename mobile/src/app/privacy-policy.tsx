import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ShieldCheck } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { GlassBackdrop } from '@/components/ui/GlassBackdrop';
import { FloatingBackHeader, PILL_TOP_OFFSET, PILL_CLEARANCE } from '@/components/ui/FloatingBackHeader';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/**
 * Full privacy policy text, kept as the single source of truth for both this in-app
 * screen and whatever is published at a public URL for app-store listings — copy
 * changes here should land in both places at once.
 *
 * Scope is deliberately data-handling facts only (what's collected, how it's stored,
 * who it's shared with, retention, deletion) — not a compliance/risk disclosure
 * document. Keep it that way; anything about API terms-of-service risk belongs in
 * internal project notes, not a public-facing policy.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const text = useThemeColor({}, 'text');
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: text }]}>{title}</Text>
      {children}
    </View>
  );
}

function P({ children }: { children: React.ReactNode }) {
  const inkDim = useThemeColor({}, 'inkDim');
  return <Text style={[styles.paragraph, { color: inkDim }]}>{children}</Text>;
}

/** A sentence worth a reader's (or a search crawler's) attention — bold and full
 * text-color contrast rather than the dimmed paragraph tone everything else uses. */
function Highlight({ children }: { children: React.ReactNode }) {
  const text = useThemeColor({}, 'text');
  return <Text style={[styles.paragraph, styles.highlight, { color: text }]}>{children}</Text>;
}

export default function PrivacyPolicyScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const noun = useDeviceNoun();

  return (
    <View style={styles.screen}>
      <GlassBackdrop />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + PILL_TOP_OFFSET + PILL_CLEARANCE }]}>
        <Text style={styles.updated}>Last updated 2026-09-17</Text>

        <P>
          Cityroam is a ride-tracking app for electric boards and scooters, built and run by an independent developer (@neowara on GitHub),
          not a company. This page explains what data Cityroam collects, how it's stored, who it's shared with, and how to have it deleted.
        </P>

        <Section title="Account">
          <P>
            Cityroam accounts are issued by the developer. There is no public sign-up. An account is an email address and a password, stored
            on Cityroam's own self-hosted server rather than a third-party cloud.
          </P>
        </Section>

        <Section title="Ride data">
          <P>
            Every ride is recorded as a trip: its GPS route, speed, distance, duration, riding mode, and the
            {` ${noun.lower}`}'s own telemetry (battery level, voltage) sampled during the ride. A trip is written to the phone's local
            storage the instant it ends, then synced to your Cityroam account when a connection is available.
          </P>
          <Highlight>A deleted trip stays recoverable for 7 days, then is permanently removed from Cityroam's server.</Highlight>
        </Section>

        <Section title="Location">
          <P>
            Cityroam reads your location while a ride is recording and while your {noun.lower} is connected, so a ride can start on its own.
            It also takes a single position when you open the app, for the map. If you set a home area, Android tells Cityroam when you
            leave it so it can reconnect to your {noun.lower}
            early. There is no location tracking while your {noun.lower} is disconnected.
          </P>
          <P>
            Route coordinates are sent to Cityroam's own self-hosted routing service for road-matching, and to Open-Meteo, a third-party
            weather service, to add weather to a ride. Open-Meteo receives only coordinates, never your account, name or anything else that
            identifies you.
          </P>
        </Section>

        <Section title={`Connecting to your ${noun.lower}`}>
          <P>
            Cityroam pairs directly with your {noun.lower} over Bluetooth. No cloud connection is needed to ride or record a trip. For Tynee
            boards, pairing works by signing in once with the Tuya account that already owns the board, so Cityroam can read the board's own
            connection keys.
          </P>
          <Highlight>
            Your Tuya email and password go straight to Tuya's servers to sign in. They are never sent to Cityroam's server and never stored
            by Cityroam.
          </Highlight>
          <Highlight>
            The {noun.lower}'s connection keys, once read, are stored only on your phone, encrypted by Android's hardware-backed keystore.
            They are never uploaded to Cityroam's server or seen by the developer.
          </Highlight>
        </Section>

        <Section title="Health data">
          <P>
            If you grant Android Health Connect permission, Cityroam reads your weight (to sharpen range estimates) and, per ride, heart
            rate and step data to show alongside that trip. With your permission, Cityroam can also write finished rides back to Health
            Connect as workouts, so they appear alongside your other exercise data. Health Connect access is entirely optional and can be
            revoked at any time in Android's settings.
          </P>
        </Section>

        <Section title="What Cityroam does not do">
          <Highlight>Cityroam has no advertising, no analytics SDKs, and no data brokers.</Highlight>
          <Highlight>Your data is never sold, rented, or shared with advertisers or marketers.</Highlight>
          <P>
            The only outside services Cityroam talks to are the ones described above (Tuya, for board pairing; Open-Meteo, for weather).
            Each receives only the data it needs for that job.
          </P>
        </Section>

        <Section title="Debug logs">
          <P>
            Cityroam keeps a debug log of app activity on your phone to help diagnose problems. While you're signed in, log entries are also
            uploaded to Cityroam's own server for the same purpose. They describe what the app did (connections, ride starts and stops, sync
            results) and can include readings tied to a ride, such as heart rate, weight or where the ride started. The log is never shared
            with anyone else. You can also share the log file yourself from Settings.
          </P>
        </Section>

        <Section title="Data retention & deletion">
          <P>
            Trips and account data are kept for as long as your account exists. To delete your account and all of its data, email{' '}
            <Text style={styles.emailInline}>cityroamapp@casa-verde.casa</Text> and it will be actioned promptly.
          </P>
        </Section>

        <Section title="Children">
          <P>Cityroam is not directed at children and is not knowingly used to collect data from anyone under 13.</P>
        </Section>

        <Section title="Changes to this policy">
          <P>
            If this policy changes in a way that affects what data is collected or how it's used, the "Last updated" date above will change
            and, for a material change, the app will surface a notice on next launch.
          </P>
        </Section>

        <Section title="Contact">
          <P>
            Questions about this policy or your data: <Text style={styles.emailInline}>cityroamapp@casa-verde.casa</Text>
          </P>
        </Section>
      </ScrollView>
      <FloatingBackHeader icon={ShieldCheck} title="Privacy policy" onPress={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 60, gap: 4 },
  updated: { fontSize: 12, opacity: 0.5, marginBottom: 14 },
  section: { marginTop: 18, gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  paragraph: { fontSize: 14, lineHeight: 21 },
  highlight: { fontWeight: '700' },
  emailInline: { fontWeight: '600' },
});
