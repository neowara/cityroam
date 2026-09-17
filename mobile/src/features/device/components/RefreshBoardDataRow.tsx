import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import { Card } from '@/components/ui/Card';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { useAppTheme } from '@/lib/theme';
import { detectCountry } from '@/features/device/countryCallingCodes';
import { directSignIn, getActiveDeviceId, isSignedInToTuya, refreshBoardFromAccount } from '@/features/device/deviceLink';

/**
 * Re-reads a paired board's key material from the Tuya account without unpairing it.
 *
 * Until this existed the account could only be read while pairing, and the Tuya session
 * is native in-memory state that any restart clears — so refreshing anything meant
 * forgetting the board and pairing it again, discarding the local record (queued
 * settings, cached values, the learned Bluetooth address) to re-read data the account
 * already had. Credentials are only asked for when the session is actually gone.
 */
export function RefreshBoardDataRow() {
  const { accentColor } = useAppTheme();
  const noun = useDeviceNoun();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');
  const line = useThemeColor({}, 'line');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [askCredentials, setAskCredentials] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const passwordRef = useRef<TextInput>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setResult(null);
    setFailed(false);
    try {
      const devId = await getActiveDeviceId();
      if (!devId) throw new Error(`No ${noun.lower} is paired.`);
      const { schemaFromAccount } = await refreshBoardFromAccount(devId);
      setResult(
        schemaFromAccount
          ? `Refreshed. The account supplied this ${noun.lower}’s own settings schema.`
          : `Refreshed. The account had no schema for this ${noun.lower}, so the built-in one is still in use.`,
      );
    } catch (err) {
      setFailed(true);
      setResult(err instanceof Error ? err.message.split('\n')[0] : String(err));
    } finally {
      setBusy(false);
    }
  }, [noun]);

  const start = useCallback(() => {
    if (isSignedInToTuya()) {
      void run();
      return;
    }
    setResult(null);
    setFailed(false);
    setAskCredentials(true);
  }, [run]);

  const signInThenRun = useCallback(async () => {
    setBusy(true);
    setFailed(false);
    try {
      await directSignIn(email.trim(), password, detectCountry().callingCode);
      setPassword('');
      setAskCredentials(false);
      await run();
    } catch (err) {
      setFailed(true);
      setResult(err instanceof Error ? err.message.split('\n')[0] : String(err));
    } finally {
      setBusy(false);
    }
  }, [email, password, run]);

  const canSignIn = /.+@.+\..+/.test(email.trim()) && password.length > 0 && !busy;

  return (
    <Card style={styles.card}>
      <PressableScale style={[styles.button, { backgroundColor: accentColor }]} disabled={busy} onPress={start}>
        <View style={styles.buttonRow}>
          <RefreshCw size={16} color="#fff" />
          <Text style={styles.buttonText}>{busy ? 'Refreshing…' : `Refresh ${noun.lower} data from Tuya`}</Text>
        </View>
      </PressableScale>
      {result && <Text style={[styles.note, { color: failed ? crit : inkDim }]}>{result}</Text>}
      <Text style={[styles.note, { color: inkDim }]}>
        Re-reads this {noun.lower}&apos;s keys and settings schema from your Tuya account. The pairing, your queued settings and the{' '}
        {noun.lower}&apos;s known address are all kept.
      </Text>

      <AppModal visible={askCredentials} onRequestClose={() => !busy && setAskCredentials(false)} contentStyle={styles.modal}>
        <Text style={[styles.modalTitle, { color: text }]}>Sign in to Tuya</Text>
        <Text style={[styles.note, { color: inkDim, textAlign: 'center' }]}>
          The Tuya session ends when the app restarts, so this needs your account again. Only the
          {noun.lower}&apos;s keys are stored, not your login.
        </Text>
        <TextInput
          style={[styles.input, { borderColor: line, color: text }]}
          placeholder="Email"
          placeholderTextColor={inkDim}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          value={email}
          onChangeText={setEmail}
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <TextInput
          ref={passwordRef}
          style={[styles.input, { borderColor: line, color: text }]}
          placeholder="Password"
          placeholderTextColor={inkDim}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          returnKeyType="go"
          onSubmitEditing={() => canSignIn && signInThenRun()}
        />
        {busy ? (
          <ActivityIndicator color={accentColor} />
        ) : (
          <>
            <PressableScale
              style={[styles.button, { backgroundColor: canSignIn ? accentColor : line }]}
              disabled={!canSignIn}
              onPress={signInThenRun}>
              <Text style={styles.buttonText}>Sign in and refresh</Text>
            </PressableScale>
            <PressableScale style={[styles.secondary, { borderColor: line }]} onPress={() => setAskCredentials(false)}>
              <Text style={[styles.secondaryText, { color: inkDim }]}>Cancel</Text>
            </PressableScale>
          </>
        )}
      </AppModal>
    </Card>
  );
}

const styles = {
  card: { gap: 10 },
  stretch: { alignSelf: 'stretch' as const },
  button: { borderRadius: 10, padding: 14, alignItems: 'center' as const, alignSelf: 'stretch' as const },
  buttonRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
  buttonText: { color: '#fff', fontWeight: '700' as const },
  note: { fontSize: 13, opacity: 0.85, lineHeight: 18 },
  modal: { gap: 12, padding: 22, alignItems: 'stretch' as const },
  modalTitle: { fontSize: 18, fontWeight: '700' as const, textAlign: 'center' as const },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, alignSelf: 'stretch' as const },
  secondary: { borderRadius: 10, borderWidth: 1, paddingVertical: 12, alignItems: 'center' as const, alignSelf: 'stretch' as const },
  secondaryText: { fontWeight: '600' as const },
};
