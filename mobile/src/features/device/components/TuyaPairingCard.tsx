import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, TextInput, View, type ListRenderItemInfo } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Check, AlertTriangle, KeyRound, Eye, EyeOff, Search, ChevronRight } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { AppModal } from '@/components/ui/AppModal';
import { PressableScale } from '@/components/ui/PressableScale';
import {
  PairedDevicePanel,
  cleanErrorMessage,
  pairingFormStyles,
  pairingModalStyles,
} from '@/features/device/components/PairedDevicePanel';
import { useAppTheme } from '@/lib/theme';
import { countries, countryFlag, detectCountry, type Country } from '@/features/device/countryCallingCodes';
import { useDeviceNoun } from '@/features/device/deviceNoun';
import { directSignIn, directListDevices, directPairDevice, type DirectAccountDevice } from '@/features/device/deviceLink';

/**
 * SDK-free pairing: sign in with the Tuya account that already owns the board, pick
 * the board from the account's device list, and Turbo stores its key material — the
 * board is never re-bound and keeps working in the Tuya Smart app exactly as before.
 * Boards also seen advertising over BLE are marked "nearby" as the strongest hint
 * for which one is yours (the scan is best-effort; a debug build can't run it).
 */

/**
 * The native layer rejects with a Tuya error code plus actionable text, but one native
 * message is actively misleading for a social-signup account (which has no password at
 * all): "Wrong email or password". The research note's fix is Tuya's own escape hatch —
 * add an email in the Tuya Smart app, then set a password. Wrong-region sign-ins, on the
 * other hand, surface as unclassified Tuya codes, so they get the region-picker hint.
 */
function userFacingError(err: unknown): string {
  const message = cleanErrorMessage(err);
  const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'WRONG_CREDENTIALS' || /wrong email or password/i.test(message)) {
    return `${message}\n\nSigned up with Google or Apple? Open Tuya Smart → Me → Account and Security, add your email, then set a login password and use it here.`;
  }
  if (code === 'API_ERROR' && !/region/i.test(message)) {
    return `${message}\n\nIf your Tuya account was created in another country, go back and pick that country under Region. Tuya keeps accounts in separate regional data centres.`;
  }
  return message;
}

// Only the email is remembered. The password is never written to disk.
const REMEMBERED_EMAIL_KEY = 'tynee.rememberedTuyaEmail';

type FlowState =
  | { step: 'form' }
  | { step: 'signing-in' }
  | { step: 'listing' }
  | { step: 'choosing'; devices: DirectAccountDevice[] }
  | { step: 'pairing'; device: DirectAccountDevice }
  | { step: 'success'; name: string }
  | { step: 'error'; message: string };

function busyLabel(step: 'signing-in' | 'listing' | 'pairing', noun: { lowerPlural: string; lower: string }): string {
  if (step === 'signing-in') return 'Signing in to Tuya…';
  if (step === 'listing') return `Finding your ${noun.lowerPlural}…`;
  return `Reading ${noun.lower} keys…`;
}

export function TuyaPairingCard() {
  const { accentColor } = useAppTheme();
  const noun = useDeviceNoun();
  const text = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const crit = useThemeColor({}, 'crit');
  const good = useThemeColor({}, 'good');
  const line = useThemeColor({}, 'line');
  const [flow, setFlow] = useState<FlowState>({ step: 'form' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const passwordRef = useRef<TextInput>(null);
  const [showPassword, setShowPassword] = useState(false);
  // Defaults on: most riders sign in from the same phone every time, and a remembered
  // email is the common case a password manager alone doesn't cover (it still fills
  // the password, but only once something has put the matching email in the field).
  const [rememberEmail, setRememberEmail] = useState(true);
  // The device's own region is right for essentially every real user; the picker exists
  // for the rest. Tuya routes login to a regional data centre by dialling code, and a
  // mismatch is rejected as an access error rather than a credentials one — which is why
  // the region is asked for at all, and why it must not read as a phone-number field.
  const [country, setCountry] = useState(() => detectCountry());
  // The detected default, kept separate from `country` (the currently selected one,
  // which changes the instant the rider picks something else) — the list always pins
  // this one to the top, not whatever happens to be selected right now.
  const detectedRegion = useMemo(() => detectCountry().region, []);
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState('');
  const [modalVisible, setModalVisible] = useState(false);

  const emailOk = /.+@.+\..+/.test(email.trim());
  const passwordOk = password.length > 0;
  const canSignIn = emailOk && passwordOk;

  const filteredCountries = useMemo(() => {
    const query = countryQuery.trim().toLowerCase();
    const all = query ? countries().filter((c) => c.name.toLowerCase().includes(query) || c.callingCode === query) : countries();
    // Always the detected default, never whatever's currently selected — picking a
    // different country must not bump that pick to the top and bury the detected one.
    const detectedIndex = all.findIndex((c) => c.region === detectedRegion);
    if (detectedIndex <= 0) return all;
    return [all[detectedIndex], ...all.slice(0, detectedIndex), ...all.slice(detectedIndex + 1)];
  }, [countryQuery, detectedRegion]);

  // Rendering all ~195 countries synchronously (as a ScrollView + .map(), the
  // previous shape) meant mounting ~195 Reanimated-backed PressableScale rows in one
  // commit — a real, measured multi-hundred-ms-to-1s cost on-device, not a native
  // Modal problem this time (confirmed via logcat: only one Dialog.show event, not a
  // burst). FlatList only mounts what's actually on screen.
  const countryKeyExtractor = useCallback((c: Country) => c.region, []);
  const renderCountryItem = useCallback(
    ({ item: c }: ListRenderItemInfo<Country>) => {
      const selected = c.region === country.region;
      return (
        <PressableScale
          style={[modalStyles.deviceRow, { borderBottomColor: line }]}
          onPress={() => {
            setCountry(c);
            setCountryPickerOpen(false);
          }}>
          <Text style={styles.regionFlag}>{countryFlag(c.region)}</Text>
          <Text style={[modalStyles.deviceName, styles.countryRowText, { color: selected ? accentColor : text }]} numberOfLines={1}>
            {c.name}
          </Text>
          {selected && <Check size={18} color={accentColor} />}
        </PressableScale>
      );
    },
    [country.region, line, accentColor, text],
  );

  const start = useCallback(() => {
    setModalVisible(true);
    setFlow({ step: 'form' });
    // Loaded on each open rather than once at mount: this card can render long before
    // the rider ever taps "Connect your board", and AsyncStorage could change under it
    // in the meantime (a different device's pairing flow, a cleared app data).
    void AsyncStorage.getItem(REMEMBERED_EMAIL_KEY).then((stored) => {
      if (stored) setEmail(stored);
    });
  }, []);

  const pair = useCallback(async (device: DirectAccountDevice) => {
    setFlow({ step: 'pairing', device });
    try {
      // Reads this board's keys from the Tuya account and stores them — no Bluetooth
      // involved. registerDirectBoard (inside directPairDevice) is what starts the
      // actual BLE session afterward, which is the first point Bluetooth permission is
      // asked for; the 'success' copy below reflects that ordering.
      const paired = await directPairDevice(device);
      setFlow({ step: 'success', name: paired.name ?? paired.devId });
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
    }
  }, []);

  const signIn = useCallback(async () => {
    if (!canSignIn) return;
    setFlow({ step: 'signing-in' });
    try {
      await directSignIn(email.trim(), password, country.callingCode);
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
      return;
    }
    // The password is dropped here — it was a parameter of the sign-in call only.
    setPassword('');
    setShowPassword(false);
    if (rememberEmail) {
      await AsyncStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
    } else {
      await AsyncStorage.removeItem(REMEMBERED_EMAIL_KEY);
    }
    setFlow({ step: 'listing' });
    try {
      const devices = await directListDevices();
      if (devices.length === 0) {
        setFlow({
          step: 'error',
          message: `No devices found in this Tuya account. Pair your ${noun.lower} in the Tuya Smart app first, then try again.`,
        });
        return;
      }
      // Nothing to choose between with only one board on the account — skip straight
      // to pairing it instead of making the rider tap a list of one.
      if (devices.length === 1) {
        void pair(devices[0]);
        return;
      }
      setFlow({ step: 'choosing', devices });
    } catch (err) {
      setFlow({ step: 'error', message: userFacingError(err) });
    }
  }, [canSignIn, email, password, country, noun, rememberEmail, pair]);

  const busy = flow.step === 'signing-in' || flow.step === 'listing' || flow.step === 'pairing';

  return (
    <>
      <PairedDevicePanel
        refreshKey={flow.step}
        footnote={`Cityroam holds this ${noun.lower}'s keys for a direct Bluetooth connection. "Forget" deletes them and the local pairing. The ${noun.lower} itself stays bound to your Tuya account, its own app keeps working, and you can pair it here again anytime.`}
        forgetBody={`Cityroam deletes the ${noun.lower}'s keys and its local pairing record. The ${noun.lower} itself stays bound to your Tuya account, its own app keeps working, and you can pair it here again anytime.`}
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
        // The region picker is a content swap inside this SAME modal (below), not a
        // second stacked <AppModal> — opening a second native Modal on Android means
        // a whole new Dialog/Window (WindowManagerGlobal#addView, a fresh
        // BLASTBufferQueue, a focus transfer), confirmed in logcat as the actual
        // source of a very real ~1.5s delay, not a JS-side slowdown. Every other step
        // change in this dialog (form -> signing-in -> choosing -> success) already
        // works this way for the same reason: swapping `children` inside one already-
        // open Modal is instant; opening another Modal on top never is.
        visible={modalVisible}
        onRequestClose={() => {
          if (countryPickerOpen) {
            setCountryPickerOpen(false);
            return;
          }
          if (!busy) setModalVisible(false);
        }}
        contentStyle={countryPickerOpen ? modalStyles.pickerCard : modalStyles.card}
        showCloseButton={!countryPickerOpen}
        footer={
          flow.step === 'form' && !countryPickerOpen ? (
            <>
              <PressableScale
                style={[modalStyles.confirmButton, { backgroundColor: accentColor, opacity: canSignIn ? 1 : 0.5 }]}
                disabled={!canSignIn}
                onPress={signIn}>
                <Text style={modalStyles.confirmText}>Sign in</Text>
              </PressableScale>
              {!canSignIn && <Text style={[modalStyles.body, { color: inkDim }]}>Enter your email and Tuya password to continue.</Text>}
            </>
          ) : undefined
        }>
        {countryPickerOpen ? (
          <>
            <View style={styles.pickerHeader}>
              <Text style={[modalStyles.title, styles.pickerTitle, { color: text }]}>Choose your region</Text>
              <PressableScale
                style={styles.pickerDone}
                onPress={() => setCountryPickerOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close country picker">
                <Text style={[styles.pickerDoneText, { color: accentColor }]}>Done</Text>
              </PressableScale>
            </View>
            <Text style={[modalStyles.body, { color: inkDim }]}>The country your Tuya account was created in.</Text>
            <TextInput
              style={[styles.input, { borderColor: line, color: text }]}
              placeholder="Search countries"
              placeholderTextColor={inkDim}
              autoCorrect={false}
              value={countryQuery}
              onChangeText={setCountryQuery}
              returnKeyType="search"
              onSubmitEditing={() => {
                if (filteredCountries.length === 0) return;
                setCountry(filteredCountries[0]);
                setCountryPickerOpen(false);
              }}
            />
            <FlatList
              data={filteredCountries}
              keyExtractor={countryKeyExtractor}
              renderItem={renderCountryItem}
              style={styles.countryList}
              contentContainerStyle={styles.countryListContent}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              initialNumToRender={14}
              windowSize={5}
              ListEmptyComponent={
                <Text style={[modalStyles.body, styles.noResults, { color: inkDim }]}>No country matches "{countryQuery}".</Text>
              }
            />
          </>
        ) : (
          <>
            {flow.step === 'form' && (
              <>
                <Text style={[modalStyles.title, { color: text }]}>Sign in with Tuya</Text>
                <Text style={[modalStyles.body, { color: inkDim }]}>
                  Use the Tuya Smart account your {noun.lower} is already paired to.
                </Text>
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
                    returnKeyType="go"
                    onSubmitEditing={() => canSignIn && signIn()}
                  />
                  <PressableScale
                    style={[styles.passwordToggle, { borderColor: line }]}
                    onPress={() => setShowPassword((v) => !v)}
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? <EyeOff size={16} color={inkDim} /> : <Eye size={16} color={inkDim} />}
                  </PressableScale>
                </View>
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
                <PressableScale
                  style={[styles.regionRow, { borderColor: line }]}
                  onPress={() => {
                    setCountryQuery('');
                    setCountryPickerOpen(true);
                  }}>
                  <Text style={styles.regionFlag}>{countryFlag(country.region)}</Text>
                  <View style={styles.regionTextWrap}>
                    <Text style={[styles.regionLabel, { color: inkDim }]}>Region</Text>
                    <Text style={[styles.regionValue, { color: text }]}>{country.name}</Text>
                  </View>
                  <ChevronRight size={18} color={inkDim} />
                </PressableScale>
                <Text style={[modalStyles.body, { color: inkDim }]}>Where your Tuya account lives.</Text>
              </>
            )}

            {(flow.step === 'signing-in' || flow.step === 'listing' || flow.step === 'pairing') && (
              <>
                <ActivityIndicator size="small" color={accentColor} />
                <Text style={[modalStyles.busyLabel, { color: inkDim }]}>{busyLabel(flow.step, noun)}</Text>
              </>
            )}

            {flow.step === 'choosing' && (
              <>
                <Text style={[modalStyles.title, { color: text }]}>{`Pick your ${noun.lower}`}</Text>
                <Text style={[modalStyles.body, { color: inkDim }]}>
                  {`Every ${noun.lower} on this account is listed below. Picking one just reads its keys from your account. Nothing connects yet.`}
                </Text>
                {flow.devices.map((device) => (
                  <PressableScale
                    key={device.devId}
                    style={[modalStyles.deviceRow, { borderBottomColor: line }]}
                    onPress={() => pair(device)}>
                    <Search size={16} color={inkDim} style={styles.deviceFarIcon} />
                    <View style={styles.deviceMetaWrap}>
                      <Text style={[modalStyles.deviceName, { color: text }]}>{device.name ?? device.devId}</Text>
                      <Text style={[modalStyles.deviceMeta, { color: inkDim }]}>{device.devId}</Text>
                    </View>
                  </PressableScale>
                ))}
              </>
            )}

            {flow.step === 'success' && (
              <>
                <Check size={28} color={good} />
                <Text style={[modalStyles.title, { color: text }]}>Paired</Text>
                <Text style={[modalStyles.body, { color: inkDim }]}>
                  {`Cityroam read ${flow.name}'s keys from your account. Turn it on and keep it close. Cityroam connects over Bluetooth directly, no internet needed.`}
                </Text>
                <PressableScale
                  style={[modalStyles.confirmButton, { backgroundColor: accentColor }]}
                  onPress={() => setModalVisible(false)}>
                  <Text style={modalStyles.confirmText}>Done</Text>
                </PressableScale>
              </>
            )}

            {flow.step === 'error' && (
              <>
                <AlertTriangle size={28} color={crit} />
                <Text style={[modalStyles.title, { color: text }]}>Couldn't connect</Text>
                <Text style={[modalStyles.errorBody, { color: inkDim }]}>{flow.message}</Text>
                <PressableScale
                  style={[modalStyles.confirmButton, { backgroundColor: accentColor }]}
                  onPress={() => setFlow({ step: 'form' })}>
                  <Text style={modalStyles.confirmText}>Try again</Text>
                </PressableScale>
              </>
            )}
          </>
        )}
      </AppModal>
    </>
  );
}

const styles = {
  ...pairingFormStyles,
  regionRow: {
    alignSelf: 'stretch' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 8,
  },
  regionFlag: { fontSize: 20 },
  regionTextWrap: { flex: 1 },
  regionLabel: { fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  regionValue: { fontSize: 14, fontWeight: '600' as const },
  // A real (not max) height — FlatList needs a definite viewport to actually
  // virtualize against; without one it can't tell what's "visible" and quietly falls
  // back to rendering every row up front, which is exactly the ~200-row cost this
  // was introduced to avoid.
  countryList: { alignSelf: 'stretch' as const, width: '100%' as const, height: 320 },
  countryListContent: { alignSelf: 'stretch' as const },
  countryRowText: { flex: 1 },
  pickerHeader: {
    alignSelf: 'stretch' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  },
  pickerTitle: { flex: 1, textAlign: 'left' as const },
  pickerDone: { paddingHorizontal: 4, paddingVertical: 6 },
  pickerDoneText: { fontSize: 15, fontWeight: '600' as const },
  noResults: { textAlign: 'left' as const, marginTop: 12 },
};

const modalStyles = pairingModalStyles;
