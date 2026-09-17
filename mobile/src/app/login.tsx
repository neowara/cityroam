import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useMutation } from '@tanstack/react-query';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { CityroamWordmark } from '@/components/ui/CityroamMark';
import { PressableScale } from '@/components/ui/PressableScale';
import { UpdateBanner } from '@/features/updates/components/UpdateBanner';
import { useAppTheme } from '@/lib/theme';
import { useSession } from '@/features/auth/auth';

// admin-issued accounts only, no public signup endpoint exists or ever
// will, so this screen is deliberately login-only (no "create account" link).
export default function LoginScreen() {
  const { signIn } = useSession();
  const { accentColor } = useAppTheme();
  const textColor = useThemeColor({}, 'text');
  const placeholderColor = useThemeColor({ light: '#888', dark: '#777' }, 'text');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const passwordRef = useRef<TextInput>(null);

  const login = useMutation({
    mutationFn: () => signIn(email.trim(), password),
  });

  const canSignIn = !!email && !!password && !login.isPending;

  // Accounts are admin-issued (see this screen's own note below), so there's no
  // self-service reset flow to link to — routes to the same support address Settings'
  // own "Contact" row uses, pre-filled so the rider doesn't have to compose it.
  const openForgotPassword = () => {
    const subject = 'Cityroam - User account password reset';
    const body = `Please reset my password for my account (${email.trim() || 'your account email'})`;
    void Linking.openURL(`mailto:cityroamapp@casa-verde.casa?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
  };

  const errorMessage = login.isError
    ? // Backend deliberately returns the same message for "wrong password" and
      // "unknown email" — matched here too, not distinguished in the UI copy.
      String((login.error as Error).message).startsWith('401')
      ? 'Incorrect email or password'
      : String((login.error as Error).message)
    : null;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.container}>
        <View style={styles.header}>
          <CityroamWordmark size={36} cityColor={textColor} roamColor={accentColor} />
        </View>
        {/* A rider stuck on a broken or expired login must still be able to see and
            install the fix, so the update banner is not gated behind auth. */}
        <UpdateBanner />
        <Card style={styles.cardGap}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={[styles.input, { color: textColor }]}
            placeholder="you@example.com"
            placeholderTextColor={placeholderColor}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
            editable={!login.isPending}
            returnKeyType="next"
            blurOnSubmit={false}
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            ref={passwordRef}
            style={[styles.input, { color: textColor }]}
            placeholderTextColor={placeholderColor}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            autoComplete="current-password"
            value={password}
            onChangeText={setPassword}
            editable={!login.isPending}
            returnKeyType="go"
            onSubmitEditing={() => canSignIn && login.mutate()}
          />
          <PressableScale
            style={[styles.button, { backgroundColor: accentColor, opacity: canSignIn ? 1 : 0.5 }]}
            disabled={!canSignIn}
            onPress={() => login.mutate()}>
            <Text style={styles.buttonText}>{login.isPending ? 'Signing in…' : 'Sign in'}</Text>
          </PressableScale>
          {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
          <PressableScale style={styles.forgotRow} onPress={openForgotPassword}>
            <Text style={[styles.forgotText, { color: accentColor }]}>Forgot your password?</Text>
          </PressableScale>
        </Card>
        <Text style={styles.note}>Accounts are invite-only. There's no sign-up.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 20 },
  header: { alignItems: 'center', justifyContent: 'center', marginBottom: 32 },
  cardGap: { gap: 8 },
  label: { fontSize: 13, marginTop: 10, marginBottom: 4, opacity: 0.8 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#8884', borderRadius: 10, padding: 12, fontSize: 15 },
  button: { marginTop: 16, borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { marginTop: 10, fontSize: 13, color: '#e5484d' },
  forgotRow: { marginTop: 12, alignItems: 'center' },
  forgotText: { fontSize: 13, fontWeight: '600' },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18, textAlign: 'center' },
});
