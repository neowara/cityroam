import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AlertTriangle, Bluetooth, Check, Eye, EyeOff, KeyRound, RefreshCw, Search } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import {
  PairedDevicePanel,
  cleanErrorMessage,
  pairingFormStyles as styles,
  pairingModalStyles as modalStyles,
} from '@/features/device/components/PairedDevicePanel';
import { useAppTheme } from '@/lib/theme';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { ensureBlePermissions } from '@/features/device/deviceLink/permissions';
import NaveeBleNative from '@modules/navee-ble/src/NaveeBle';
import {
  naveeCaptcha,
  naveeListVehicles,
  naveePairScanned,
  naveePairVehicle,
  naveeSignIn,
  type NaveeAccountVehicle,
  type NaveeCaptcha,
  type NaveeScanResult,
} from '@/features/device/deviceLink';

const SCAN_TIMEOUT_MS = 12_000;

/**
 * NAVEE pairing: sign in with the NAVEE account the scooter is bound to, pick the
 * scooter, and Cityroam stores the account id its Bluetooth auth checks. Same flow and
 * look as the Tynee card (TuyaPairingCard); the one extra step is the image code
 * NAVEE's own login asks for. The scooter stays bound to the NAVEE account and keeps
 * working in the NAVEE app.
 */

const REMEMBERED_EMAIL_KEY = 'cityroam.rememberedNaveeEmail';

type FlowState =
  | { step: 'form' }
  | { step: 'signing-in' }
  | { step: 'listing' }
  | { step: 'choosing'; vehicles: NaveeAccountVehicle[] }
  | { step: 'scanning'; results: NaveeScanResult[]; finished: boolean }
  | { step: 'pairing' }
  | { step: 'success'; name: string }
  | { step: 'error'; message: string };

function userFacingError(err: unknown): string {
  const message = cleanErrorMessage(err);
  const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'APP_OUTDATED') return message;
  if (/code|captcha|verification/i.test(message)) return `${message}\n\nType the characters from the new image exactly as shown.`;
  return message;
}

export function NaveePairingCard() {
  const { accentColor } = useAppTheme();
  const noun = useDeviceNoun();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');
  const good = useThemeColor({}, 'good');
  const line = useThemeColor({}, 'line');

  const [modalVisible, setModalVisible] = useState(false);
  const [flow, setFlow] = useState<FlowState>({ step: 'form' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberEmail, setRememberEmail] = useState(true);
  const [captcha, setCaptcha] = useState<NaveeCaptcha | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [captchaCode, setCaptchaCode] = useState('');
  const passwordRef = useRef<TextInput>(null);
  const codeRef = useRef<TextInput>(null);

  // A code is single-use on NAVEE's side, so every attempt gets a fresh image.
  const loadCaptcha = useCallback(async () => {
    setCaptcha(null);
    setCaptchaError(null);
    setCaptchaCode('');
    try {
      setCaptcha(await naveeCaptcha());
    } catch (err) {
      setCaptchaError(userFacingError(err));
    }
  }, []);

  const start = useCallback(() => {
    setModalVisible(true);
    setFlow({ step: 'form' });
    void loadCaptcha();
    void AsyncStorage.getItem(REMEMBERED_EMAIL_KEY).then((stored) => {
      if (stored) setEmail(stored);
    });
  }, [loadCaptcha]);

  const pair = useCallback(
    async (vehicle: NaveeAccountVehicle) => {
      setFlow({ step: 'pairing' });
      try {
        const paired = await naveePairVehicle(vehicle);
        setFlow({ step: 'success', name: paired.name ?? `your ${noun.lower}` });
      } catch (err) {
        setFlow({ step: 'error', message: userFacingError(err) });
      }
    },
    [noun],
  );

  // Listens for nearby NAVEE scooters only while the 'scanning' fallback is showing
  // (reached when the account's own vehicle list came back empty — see startScanFallback).
  useEffect(() => {
    if (flow.step !== 'scanning') return;
    const sub = NaveeBleNative.addListener('onScanResult', (result) => {
      setFlow((prev) => {
        if (prev.step !== 'scanning') return prev;
        if (prev.results.some((r) => r.address === result.address)) return prev;
        return { ...prev, results: [...prev.results, result] };
      });
    });
    return () => {
      sub.remove();
      NaveeBleNative.stopScan();
    };
  }, [flow.step]);

  /**
   * NAVEE's own `getVehicle` sometimes doesn't reflect a scooter add right away (seen
   * live right after unbinding a Google account and resetting the password). The BLE
   * handshake for an owned scooter only needs the signed-in account's own id, so a
   * scan finds the scooter directly instead of leaving the rider stuck behind a cloud
   * list that just hasn't caught up.
   */
  const startScanFallback = useCallback(async () => {
    setFlow({ step: 'scanning', results: [], finished: false });
    if (!(await ensureBlePermissions())) {
      setFlow({ step: 'error', message: `Cityroam needs Bluetooth permission to look for your ${noun.lower} directly.` });
      return;
    }
    try {
      await NaveeBleNative.scan(SCAN_TIMEOUT_MS);
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
      return;
    }
    setFlow((prev) => (prev.step === 'scanning' ? { ...prev, finished: true } : prev));
  }, [noun]);

  const pairScanned = useCallback(
    async (result: NaveeScanResult) => {
      NaveeBleNative.stopScan();
      setFlow({ step: 'pairing' });
      try {
        const paired = await naveePairScanned(result);
        setFlow({ step: 'success', name: paired.name ?? `your ${noun.lower}` });
      } catch (err) {
        setFlow({ step: 'error', message: userFacingError(err) });
      }
    },
    [noun],
  );

  const canSignIn = /.+@.+\..+/.test(email.trim()) && password.length > 0 && captchaCode.trim().length > 0 && captcha != null;

  const signIn = useCallback(async () => {
    if (!canSignIn || !captcha) return;
    setFlow({ step: 'signing-in' });
    try {
      await naveeSignIn(email.trim(), password, captchaCode.trim(), captcha.uuid);
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
      return;
    }
    // The password was a parameter of the sign-in call only.
    setPassword('');
    setShowPassword(false);
    if (rememberEmail) await AsyncStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
    else await AsyncStorage.removeItem(REMEMBERED_EMAIL_KEY);
    setFlow({ step: 'listing' });
    try {
      const vehicles = await naveeListVehicles();
      if (vehicles.length === 0) {
        void startScanFallback();
        return;
      }
      if (vehicles.length === 1) {
        void pair(vehicles[0]);
        return;
      }
      setFlow({ step: 'choosing', vehicles });
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
    }
  }, [canSignIn, captcha, email, password, captchaCode, rememberEmail, pair, startScanFallback]);

  const busy = flow.step === 'signing-in' || flow.step === 'listing' || flow.step === 'pairing';

  return (
    <>
      <PairedDevicePanel
        refreshKey={flow.step}
        footnote={`Cityroam keeps what this ${noun.lower} needs to accept a direct Bluetooth connection. "Forget" deletes it and the local pairing. The ${noun.lower} stays on your NAVEE account, the NAVEE app keeps working, and you can pair it here again anytime.`}
        forgetBody={`Cityroam deletes this ${noun.lower}'s connection details and its local pairing record. The ${noun.lower} stays on your NAVEE account and the NAVEE app keeps working.`}
        unpaired={
          <PressableScale style={[styles.button, { backgroundColor: accentColor }]} onPress={start}>
            <View style={styles.buttonRow}>
              <KeyRound size={16} color="#fff" />
              <Text style={styles.buttonText}>{`Connect your ${noun.lower}`}</Text>
            </View>
          </PressableScale>
        }
      />

      <AppModal
        visible={modalVisible}
        onRequestClose={() => !busy && setModalVisible(false)}
        contentStyle={modalStyles.card}
        footer={
          flow.step === 'form' ? (
            <>
              <PressableScale
                style={[modalStyles.confirmButton, { backgroundColor: accentColor, opacity: canSignIn ? 1 : 0.5 }]}
                disabled={!canSignIn}
                onPress={signIn}>
                <Text style={modalStyles.confirmText}>Sign in</Text>
              </PressableScale>
              {!canSignIn && (
                <Text style={[modalStyles.body, { color: inkDim }]}>Enter your email, NAVEE password and the code from the image.</Text>
              )}
            </>
          ) : undefined
        }>
        {flow.step === 'form' && (
          <>
            <Text style={[modalStyles.title, { color: text }]}>Sign in with NAVEE</Text>
            <Text style={[modalStyles.body, { color: inkDim }]}>{`Use the NAVEE account your ${noun.lower} is added to.`}</Text>
            <TextInput
              style={[styles.input, { borderColor: line, color: text }]}
              placeholder="Email"
              placeholderTextColor={inkDim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              importantForAutofill="yes"
              value={email}
              onChangeText={setEmail}
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
            <View style={styles.passwordRow}>
              <TextInput
                ref={passwordRef}
                style={[styles.input, styles.passwordInput, { borderColor: line, color: text }]}
                placeholder="Password"
                placeholderTextColor={inkDim}
                secureTextEntry={!showPassword}
                textContentType="password"
                autoComplete="current-password"
                importantForAutofill="yes"
                value={password}
                onChangeText={setPassword}
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => codeRef.current?.focus()}
              />
              <PressableScale
                style={[styles.passwordToggle, { borderColor: line }]}
                onPress={() => setShowPassword((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff size={16} color={inkDim} /> : <Eye size={16} color={inkDim} />}
              </PressableScale>
            </View>

            <View style={localStyles.captchaRow}>
              {captcha ? (
                <Image
                  source={{ uri: `data:image/png;base64,${captcha.imageBase64}` }}
                  style={localStyles.captchaImage}
                  resizeMode="contain"
                  accessibilityLabel="Verification image"
                />
              ) : captchaError ? (
                <Text style={[localStyles.captchaError, { color: crit }]} numberOfLines={3}>
                  {captchaError}
                </Text>
              ) : (
                <ActivityIndicator color={accentColor} style={localStyles.captchaImage} />
              )}
              <PressableScale
                style={[styles.passwordToggle, { borderColor: line }]}
                onPress={() => void loadCaptcha()}
                accessibilityRole="button"
                accessibilityLabel="New verification image">
                <RefreshCw size={16} color={inkDim} />
              </PressableScale>
            </View>
            <TextInput
              ref={codeRef}
              style={[styles.input, { borderColor: line, color: text }]}
              placeholder="Code from the image"
              placeholderTextColor={inkDim}
              autoCapitalize="none"
              autoCorrect={false}
              value={captchaCode}
              onChangeText={setCaptchaCode}
              returnKeyType="go"
              onSubmitEditing={() => canSignIn && signIn()}
            />

            <PressableScale
              style={styles.rememberRow}
              onPress={() => setRememberEmail((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: rememberEmail }}
              accessibilityLabel="Remember my email">
              <View
                style={[
                  styles.checkbox,
                  { borderColor: rememberEmail ? accentColor : line, backgroundColor: rememberEmail ? accentColor : 'transparent' },
                ]}>
                {rememberEmail && <Check size={13} color="#fff" />}
              </View>
              <Text style={[styles.rememberText, { color: inkDim }]}>Remember my email</Text>
            </PressableScale>
          </>
        )}

        {busy && (
          <>
            <ActivityIndicator size="small" color={accentColor} />
            <Text style={[modalStyles.busyLabel, { color: inkDim }]}>
              {flow.step === 'signing-in'
                ? 'Signing in to NAVEE…'
                : flow.step === 'listing'
                  ? `Finding your ${noun.lowerPlural}…`
                  : `Pairing your ${noun.lower}…`}
            </Text>
          </>
        )}

        {flow.step === 'choosing' && (
          <>
            <Text style={[modalStyles.title, { color: text }]}>{`Pick your ${noun.lower}`}</Text>
            <Text
              style={[
                modalStyles.body,
                { color: inkDim },
              ]}>{`Every ${noun.lower} on this account is listed below. Nothing connects until you pick one.`}</Text>
            {flow.vehicles.map((vehicle) => (
              <PressableScale key={vehicle.mac} style={[modalStyles.deviceRow, { borderBottomColor: line }]} onPress={() => pair(vehicle)}>
                <Search size={16} color={inkDim} style={styles.deviceFarIcon} />
                <View style={styles.deviceMetaWrap}>
                  <Text style={[modalStyles.deviceName, { color: text }]}>{vehicle.name ?? vehicle.mac}</Text>
                  <Text style={[modalStyles.deviceMeta, { color: inkDim }]}>
                    {vehicle.shareUserId > 0 ? `${vehicle.mac} · shared with you` : vehicle.mac}
                  </Text>
                </View>
              </PressableScale>
            ))}
          </>
        )}

        {flow.step === 'scanning' && (
          <>
            <Text style={[modalStyles.title, { color: text }]}>{`Looking for your ${noun.lower}`}</Text>
            <Text style={[modalStyles.body, { color: inkDim }]}>
              {`NAVEE hasn't confirmed a ${noun.lower} on this account yet, so Cityroam is looking for one over Bluetooth instead. Turn it on and keep it close.`}
            </Text>
            {!flow.finished && <ActivityIndicator color={accentColor} style={localStyles.scanIndicator} />}
            {flow.results.map((result) => (
              <PressableScale
                key={result.address}
                style={[modalStyles.deviceRow, { borderBottomColor: line }]}
                onPress={() => void pairScanned(result)}>
                <Bluetooth size={16} color={inkDim} style={styles.deviceFarIcon} />
                <View style={styles.deviceMetaWrap}>
                  <Text style={[modalStyles.deviceName, { color: text }]}>{result.name ?? result.address}</Text>
                  <Text style={[modalStyles.deviceMeta, { color: inkDim }]}>{result.address}</Text>
                </View>
              </PressableScale>
            ))}
            {flow.finished && flow.results.length === 0 && (
              <>
                <Text
                  style={[
                    modalStyles.errorBody,
                    { color: inkDim },
                  ]}>{`No ${noun.lowerPlural} found nearby. Turn it on, keep it close, and try again.`}</Text>
                <PressableScale
                  style={[modalStyles.confirmButton, { backgroundColor: accentColor }]}
                  onPress={() => void startScanFallback()}>
                  <Text style={modalStyles.confirmText}>Scan again</Text>
                </PressableScale>
              </>
            )}
          </>
        )}

        {flow.step === 'success' && (
          <>
            <Check size={28} color={good} />
            <Text style={[modalStyles.title, { color: text }]}>Paired</Text>
            <Text style={[modalStyles.body, { color: inkDim }]}>
              {`${flow.name} is paired. Turn it on and keep it close. Cityroam connects over Bluetooth directly, no internet needed.`}
            </Text>
            <PressableScale style={[modalStyles.confirmButton, { backgroundColor: accentColor }]} onPress={() => setModalVisible(false)}>
              <Text style={modalStyles.confirmText}>Done</Text>
            </PressableScale>
          </>
        )}

        {flow.step === 'error' && (
          <>
            <AlertTriangle size={28} color={crit} />
            <Text style={[modalStyles.title, { color: text }]}>Couldn&apos;t connect</Text>
            <Text style={[modalStyles.errorBody, { color: inkDim }]}>{flow.message}</Text>
            <PressableScale
              style={[modalStyles.confirmButton, { backgroundColor: accentColor }]}
              onPress={() => {
                setFlow({ step: 'form' });
                void loadCaptcha();
              }}>
              <Text style={modalStyles.confirmText}>Try again</Text>
            </PressableScale>
          </>
        )}
      </AppModal>
    </>
  );
}

const localStyles = {
  captchaRow: {
    alignSelf: 'stretch' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    marginTop: 8,
  },
  captchaImage: { flex: 1, height: 48 },
  captchaError: { flex: 1, fontSize: 12, lineHeight: 16 },
  scanIndicator: { marginTop: 8 },
};
