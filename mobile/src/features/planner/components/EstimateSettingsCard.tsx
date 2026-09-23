import { useEffect, useRef, useState } from 'react';
import { KeyboardTypeOptions, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { Card } from '@/components/ui/Card';
import { PressableScale } from '@/components/ui/PressableScale';
import { SelectField } from '@/components/ui/SelectField';
import { api, type BoardCatalogEntry, type DeviceSetting } from '@/lib/api';
import { invalidateRangeEstimate } from '@/lib/queries';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { useAppTheme } from '@/lib/theme';
import { useDeviceNoun } from '@/features/device/deviceNoun';

/**
 * User-entered board data that sharpens range-estimate accuracy beyond the
 * backend's hardcoded reference values. Per-device (GET/PUT
 * /devices/{deviceId}/settings), not a single phone-wide value — switching boards
 * (the same picker as the trip/stats device filter, shown only when >1 board is
 * paired) loads that board's own saved weight/capacity instead of carrying over
 * whichever board was last edited here. Draft-then-save, same pattern as the
 * Server-address card.
 *
 * The card also edits the board spec-sheet fields (cellConfig,
 * packNominalVoltageV, motorPowerW, escModel, wheelType, truckSizeInches) and the
 * friendly deviceName. Spec fields resolve from the app-level Tynee catalog
 * (GET /devices/catalog) via a dropdown picker instead of free text; a "Custom"
 * option keeps free text as the escape hatch for boards/mods that don't match a
 * known config. Picking a catalog entry fills the spec drafts and locks them
 * read-only until a pencil (edit) button on a locked field switches it to
 * "Custom" while carrying the catalog's values across, so the rider adjusts one
 * or two fields without re-typing the rest.
 */

/** The catalog picker's "no known board" option — a named constant, not a magic string. */
const CUSTOM = 'Custom';

/** The editable spec-sheet fields (excludes the catalog's catalogId/name identity
 * fields, which aren't rider-editable). wheelDiameterMm (physical wheel diameter,
 * the physics field) and driveType (belt/hub/gear) join the existing set.
 *
 * wheelType (the legacy "110mm street" descriptive string) is deliberately NOT an
 * editable field here — wheelDiameterMm is the single canonical wheel-size input, and
 * wheelType is derived from it on save (see specDraftsToSetting) so the two can't
 * drift apart (code-review finding: duplicated wheel-size inputs). */
type SpecFieldKey = 'cellConfig' | 'packNominalVoltageV' | 'motorPowerW' | 'escModel' | 'truckSizeInches' | 'wheelDiameterMm' | 'driveType';

/** How a spec field is rendered/edited. The backend's range-estimate math only actually
 * reads cellConfig (voltage->SOC) and boardWeightKg (physics weight correction); the
 * rest are sanity-checks or descriptive metadata. So:
 *  - 'text'   — free text (cellConfig, the one field that genuinely changes the physics)
 *  - 'number' — numeric input (packNominalVoltageV/motorPowerW sanity-checks, truckSizeInches)
 *  - 'select' — dropdown of known values (escModel — the catalog only has a handful)
 *  - 'wheelSize' — numeric wheel diameter only, not the "mm street" suffix; only the
 *    value the backend's physics actually reads needs to be editable. */
type SpecFieldKind = 'text' | 'number' | 'select' | 'wheelSize';

/** A single editable spec-sheet field, driven declaratively so the six fields share one
 * render path instead of six near-identical blocks (code-review finding: repeated
 * switches / data clump). */
type SpecField = {
  key: SpecFieldKey;
  label: string;
  placeholder: string;
  testID: string;
  kind: SpecFieldKind;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'characters' | 'none' | 'sentences' | 'words';
  /** Dropdown choices for kind 'select'; defaults to ESC_MODEL_OPTIONS when omitted. */
  options?: string[];
  /** A spec only a board has, hidden for anything else. */
  boardOnly?: boolean;
};

/** Known ESC models, from the Tynee catalog (all current entries use "Hobbywing FOC
 * ESC"). A dropdown beats free text because there's only a handful of real values.
 * "Custom" is the free-text escape hatch. */
const ESC_MODEL_OPTIONS = ['Hobbywing FOC ESC', CUSTOM];

/** Known drivetrains — belt/hub/gear, the values the backend's physics reads for
 * drivetrain efficiency. "Custom" is the free-text escape hatch. */
const DRIVE_TYPE_OPTIONS = ['belt', 'hub', 'gear', CUSTOM];

const SPEC_FIELDS: SpecField[] = [
  {
    key: 'cellConfig',
    label: 'Cell config (e.g. 14S4P)',
    placeholder: 'e.g. 14S4P',
    testID: 'cellConfigInput',
    kind: 'text',
    autoCapitalize: 'characters',
  },
  {
    key: 'packNominalVoltageV',
    label: 'Pack nominal voltage (V)',
    placeholder: 'e.g. 50.4',
    testID: 'packVoltageInput',
    kind: 'number',
    keyboardType: 'decimal-pad',
  },
  {
    key: 'motorPowerW',
    label: 'Motor power (W)',
    placeholder: 'e.g. 6000',
    testID: 'motorPowerInput',
    kind: 'number',
    keyboardType: 'decimal-pad',
  },
  { key: 'escModel', label: 'ESC model', placeholder: 'e.g. Hobbywing FOC ESC', testID: 'escModelInput', kind: 'select' },
  // wheelDiameterMm is the single canonical wheel-size input (the physics field the
  // backend reads); the legacy descriptive wheelType string is derived from it on save.
  {
    key: 'wheelDiameterMm',
    label: 'Wheel size (mm)',
    placeholder: 'e.g. 105',
    testID: 'wheelDiameterInput',
    kind: 'number',
    keyboardType: 'decimal-pad',
  },
  {
    key: 'driveType',
    label: 'Drive type',
    placeholder: 'e.g. belt',
    testID: 'driveTypeInput',
    kind: 'select',
    options: DRIVE_TYPE_OPTIONS,
    boardOnly: true,
  },
  {
    key: 'truckSizeInches',
    label: 'Truck size (inches)',
    placeholder: 'e.g. 9.5',
    testID: 'truckSizeInput',
    kind: 'number',
    keyboardType: 'decimal-pad',
    boardOnly: true,
  },
];

/** Trucks are a board part, and a scooter is always hub-driven — asking a scooter rider
 * for either is asking for a spec their vehicle doesn't have. */
function specFieldsFor(brand: string | null | undefined): SpecField[] {
  return brand === 'navee' ? SPEC_FIELDS.filter((f) => !f.boardOnly) : SPEC_FIELDS;
}

/** The spec-field drafts, keyed by the same field names the API uses. */
type SpecDrafts = Record<SpecFieldKey, string>;

/** A numeric spec field's draft -> {value, invalid}; empty means "use default". */
function parseDraft(raw: string): { value: number | null; invalid: boolean } {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, invalid: false };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return { value: null, invalid: true };
  return { value, invalid: false };
}

/** null/number -> '' so a numeric field's draft is always a string (kills the repeated
 * `x == null ? '' : String(x)` ternary across every field). */
function toDraft(value: string | number | null | undefined): string {
  return value == null ? '' : String(value);
}

/** The spec fields that are numeric (parsed on save); the rest are free strings. */
const NUMERIC_SPEC_FIELDS: SpecFieldKey[] = ['packNominalVoltageV', 'motorPowerW', 'wheelDiameterMm', 'truckSizeInches'];

/** Wheel type is stored as a descriptive string like "110mm street" but the rider only
 * edits the numeric diameter. Extract the leading number (e.g. 110) for the input;
 * null when there's no parseable size. */
function wheelSizeFromType(wheelType: string | null | undefined): string {
  if (!wheelType) return '';
  const match = /^(\d+(?:\.\d+)?)/.exec(wheelType.trim());
  return match ? match[1] : '';
}

/** Rebuild the stored wheelType string from a rider-entered numeric size, preserving the
 * original suffix (e.g. "street") when present, defaulting to "street". Empty input
 * clears the field. */
function wheelTypeFromSize(sizeDraft: string, previous: string | null | undefined): string | null {
  const trimmed = sizeDraft.trim();
  if (trimmed === '') return null;
  const suffix = previous ? previous.replace(/^\d+(?:\.\d+)?/, '').trim() : '';
  return `${trimmed}mm${suffix ? ` ${suffix}` : ' street'}`;
}

function emptySpecDrafts(): SpecDrafts {
  return {
    cellConfig: '',
    packNominalVoltageV: '',
    motorPowerW: '',
    escModel: '',
    wheelDiameterMm: '',
    driveType: '',
    truckSizeInches: '',
  };
}

/** spec drafts -> the spec fields of a DeviceSetting (null when the draft is empty).
 * `previousWheelType` carries the stored "110mm street" string so the rider's numeric
 * wheel-size draft can be rebuilt with its original suffix preserved. */
function specDraftsToSetting(
  drafts: SpecDrafts,
  previousWheelType: string | null | undefined,
): Pick<
  DeviceSetting,
  'cellConfig' | 'packNominalVoltageV' | 'motorPowerW' | 'escModel' | 'wheelType' | 'wheelDiameterMm' | 'driveType' | 'truckSizeInches'
> {
  return {
    cellConfig: drafts.cellConfig.trim() === '' ? null : drafts.cellConfig.trim(),
    packNominalVoltageV: parseDraft(drafts.packNominalVoltageV).value,
    motorPowerW: parseDraft(drafts.motorPowerW).value,
    escModel: drafts.escModel.trim() === '' ? null : drafts.escModel.trim(),
    // wheelType is derived from the canonical numeric wheelDiameterMm draft (the only
    // wheel-size input the rider edits), preserving the stored "mm street" suffix.
    wheelType: wheelTypeFromSize(drafts.wheelDiameterMm, previousWheelType),
    wheelDiameterMm: parseDraft(drafts.wheelDiameterMm).value,
    driveType: drafts.driveType.trim() === '' ? null : drafts.driveType.trim(),
    truckSizeInches: parseDraft(drafts.truckSizeInches).value,
  };
}

/** Do the current spec drafts match a catalog entry? Compares normalized (trimmed) values
 * so a saved-but-untouched entry still auto-selects (code-review finding: fragile strict
 * string equality). wheelType drafts hold just the numeric size, so compare that against
 * the entry's parsed size. */
function draftsMatchEntry(drafts: SpecDrafts, entry: BoardCatalogEntry): boolean {
  return (
    drafts.cellConfig.trim() === (entry.cellConfig ?? '') &&
    toDraft(entry.packNominalVoltageV).trim() === drafts.packNominalVoltageV.trim() &&
    toDraft(entry.motorPowerW).trim() === drafts.motorPowerW.trim() &&
    drafts.escModel.trim() === (entry.escModel ?? '') &&
    toDraft(entry.wheelDiameterMm).trim() === drafts.wheelDiameterMm.trim() &&
    drafts.driveType.trim() === (entry.driveType ?? '') &&
    toDraft(entry.truckSizeInches).trim() === drafts.truckSizeInches.trim()
  );
}

/** A catalog entry -> its spec drafts (used when the rider picks a board). wheelType
 * drafts hold just the numeric size, not the "mm street" suffix. */
function entryToSpecDrafts(entry: BoardCatalogEntry): SpecDrafts {
  return {
    cellConfig: entry.cellConfig ?? '',
    packNominalVoltageV: toDraft(entry.packNominalVoltageV),
    motorPowerW: toDraft(entry.motorPowerW),
    escModel: entry.escModel ?? '',
    // Prefer the canonical numeric diameter; fall back to parsing the legacy descriptive
    // wheelType ("110mm street" -> "110") for catalog entries that predate the field.
    wheelDiameterMm: toDraft(entry.wheelDiameterMm) || wheelSizeFromType(entry.wheelType),
    driveType: entry.driveType ?? '',
    truckSizeInches: toDraft(entry.truckSizeInches),
  };
}

export function EstimateSettingsCard() {
  const noun = useDeviceNoun();
  // A separate selection from the global trip/stats device filter (useTripDeviceFilter's
  // own deviceId/setDeviceId) -- picking which board's *settings* to edit here shouldn't
  // also change which board's trips the Dashboard/Rides/Activity tabs are filtered to.
  // Only `devices` (the paired-device list) is shared.
  const { deviceId: tripFilterDeviceId, devices } = useTripDeviceFilter();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(tripFilterDeviceId ?? devices[0]?.devId ?? null);

  const [deviceNameDraft, setDeviceNameDraft] = useState('');
  const [weightDraft, setWeightDraft] = useState('');
  const [capacityDraft, setCapacityDraft] = useState('');
  const [specDrafts, setSpecDrafts] = useState<SpecDrafts>(emptySpecDrafts);
  const [catalog, setCatalog] = useState<BoardCatalogEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // When true, the rider has pressed a pencil to override a catalog board — forces the
  // picker to "Custom" while keeping the catalog's values in the drafts, so they only
  // retype the one or two fields they're changing.
  const [overrideCatalog, setOverrideCatalog] = useState(false);
  // The stored "110mm street" string for the selected board — kept so the rider's
  // numeric wheel-size draft can be rebuilt with its original suffix on save.
  const previousWheelTypeRef = useRef<string | null>(null);

  const textColor = useThemeColor({}, 'text');
  const placeholderColor = useThemeColor({ light: '#888', dark: '#777' }, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const good = useThemeColor({}, 'good');
  const { accentColor } = useAppTheme();
  const queryClient = useQueryClient();

  // Falls back to the first paired device once the list loads, if nothing was selected
  // yet (mirrors useTripDeviceFilter's own "board forgotten elsewhere" guard).
  if (selectedDeviceId == null && devices.length > 0) setSelectedDeviceId(devices[0].devId);

  // The selected device's brand (tynee/navee) — the catalog picker is filtered to that
  // brand so a Tynee board only ever shows Tynee models and a NAVEE board only NAVEE
  // models. A device without a brand (legacy Tynee) or a "custom" board falls back to
  // the full catalog.
  const selectedDeviceBrand = devices.find((d) => d.devId === selectedDeviceId)?.brand;

  // Load the app-level catalog for the spec picker, filtered to the selected device's
  // brand so a Tynee device only ever shows Tynee boards (and vice-versa). Reloads when
  // the rider switches to a board of a different brand.
  useEffect(() => {
    let cancelled = false;
    api
      .getBoardCatalog(selectedDeviceBrand)
      .then((res) => {
        if (!cancelled) setCatalog(res.catalog ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[estimateInputs] catalog', err);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDeviceBrand]);

  // A new selection clears the last one's load error, and no selection clears the drafts.
  // The drafts of a newly selected board are filled by the load below.
  const [draftsFor, setDraftsFor] = useState(selectedDeviceId);
  if (selectedDeviceId !== draftsFor) {
    setDraftsFor(selectedDeviceId);
    setLoadError(null);
    if (!selectedDeviceId) {
      setDeviceNameDraft('');
      setWeightDraft('');
      setCapacityDraft('');
      setSpecDrafts(emptySpecDrafts());
      setOverrideCatalog(false);
    }
  }

  // Hydrate the drafts from the selected board's saved settings.
  useEffect(() => {
    if (!selectedDeviceId) return;
    let cancelled = false;
    api
      .getDeviceSettings(selectedDeviceId)
      .then((setting) => {
        if (cancelled) return;
        setDeviceNameDraft(setting?.deviceName ?? '');
        setWeightDraft(toDraft(setting?.boardWeightKg));
        setCapacityDraft(toDraft(setting?.batteryCapacityWh));
        previousWheelTypeRef.current = setting?.wheelType ?? null;
        setSpecDrafts({
          cellConfig: setting?.cellConfig ?? '',
          packNominalVoltageV: toDraft(setting?.packNominalVoltageV),
          motorPowerW: toDraft(setting?.motorPowerW),
          escModel: setting?.escModel ?? '',
          // Prefer the canonical numeric diameter; fall back to parsing the legacy
          // descriptive wheelType for devices saved before the diameter field existed.
          wheelDiameterMm: toDraft(setting?.wheelDiameterMm) || wheelSizeFromType(setting?.wheelType),
          driveType: setting?.driveType ?? '',
          truckSizeInches: toDraft(setting?.truckSizeInches),
        });
        setOverrideCatalog(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[estimateInputs] load', err);
        setLoadError(`Could not load this ${noun.lower}’s saved values.`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDeviceId, noun.lower]);

  // The catalog picker's selected option. If the current spec drafts match a known
  // catalog entry (and the rider hasn't overridden it), that entry is shown as selected;
  // otherwise "Custom".
  const catalogOptions = [CUSTOM, ...catalog.map((c) => c.name)];
  const selectedCatalogName = !overrideCatalog ? catalog.find((c) => draftsMatchEntry(specDrafts, c))?.name : undefined;

  const onPickCatalog = (option: string) => {
    if (option === CUSTOM) {
      // Switching to Custom keeps whatever's in the drafts — the rider can tweak from
      // there without losing the current values.
      setOverrideCatalog(true);
      return;
    }
    const entry = catalog.find((c) => c.name === option);
    if (!entry) return;
    previousWheelTypeRef.current = entry.wheelType ?? null;
    setSpecDrafts(entryToSpecDrafts(entry));
    setOverrideCatalog(false);
  };

  // Pressing a pencil on a locked spec field: switch to "Custom" while keeping the
  // catalog's values in the drafts, so the rider only adjusts the one or two fields
  // they're changing.
  const startOverride = () => {
    setOverrideCatalog(true);
  };

  const setSpecDraft = (key: keyof BoardCatalogEntry, value: string) => {
    setSpecDrafts((prev) => ({ ...prev, [key]: value }));
  };

  const save = () => {
    if (!selectedDeviceId) return;
    const weight = parseDraft(weightDraft);
    const capacity = parseDraft(capacityDraft);
    const numericInvalid = NUMERIC_SPEC_FIELDS.some((key) => parseDraft(specDrafts[key]).invalid);
    if (weight.invalid || capacity.invalid || numericInvalid) {
      setSaveError('Enter a number greater than 0, or leave a field empty to use the default.');
      return;
    }
    setSaveError(null);
    // Full-replace PUT (backend/app/services/devices.py's generic upsert) -- every
    // field always goes together, even when only one changed, or the others revert to null.
    api
      .putDeviceSettings(selectedDeviceId, {
        deviceName: deviceNameDraft.trim() === '' ? null : deviceNameDraft.trim(),
        boardWeightKg: weight.value,
        batteryCapacityWh: capacity.value,
        brand: selectedDeviceBrand ?? null,
        ...specDraftsToSetting(specDrafts, previousWheelTypeRef.current),
      })
      .then(() => {
        // Board weight is composed server-side rather than folded into the phone's
        // rider-weight query — invalidate the estimate itself so the next fetch picks
        // up the newly saved board weight.
        invalidateRangeEstimate(queryClient);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err) => {
        console.error('[estimateInputs] save', err);
        setSaveError("Couldn't save. Try again.");
      });
  };

  if (devices.length === 0) {
    return (
      <Card style={styles.cardGap}>
        <Text style={styles.note}>Pair a {noun.lower} to set its weight, battery capacity, and specs.</Text>
      </Card>
    );
  }

  // Spec fields are only free-editable when the rider chose "Custom" (or pressed a pencil
  // to override a catalog board) — a picked catalog entry fills them and locks them
  // read-only until overridden.
  const specFieldsEditable = selectedCatalogName == null;

  return (
    <Card style={styles.cardGap}>
      <Text style={styles.note}>
        Your board weight and battery capacity make range estimates more accurate than the built-in defaults. Pick your board from the
        catalog to fill its specs, or leave a field empty to use the default value.
      </Text>

      {devices.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.deviceRow}
          contentContainerStyle={styles.deviceRowContent}>
          {devices.map((d) => {
            const active = d.devId === selectedDeviceId;
            return (
              <PressableScale
                key={d.devId}
                onPress={() => setSelectedDeviceId(d.devId)}
                style={[
                  styles.devicePill,
                  { borderColor: active ? accentColor : inkDim + '55' },
                  active && { backgroundColor: accentColor + '18' },
                ]}>
                <Text style={[styles.devicePillText, { color: active ? accentColor : inkDim }]} numberOfLines={1}>
                  {d.name || `Your ${noun.lower}`}
                </Text>
              </PressableScale>
            );
          })}
        </ScrollView>
      )}

      {loadError != null && <Text style={styles.error}>{loadError}</Text>}

      <Text style={styles.label}>{noun.Cap} name</Text>
      <TextInput
        testID="deviceNameInput"
        style={[styles.input, { color: textColor }]}
        placeholder="e.g. My Explorer Pro"
        placeholderTextColor={placeholderColor}
        autoCorrect={false}
        value={deviceNameDraft}
        onChangeText={setDeviceNameDraft}
      />

      {catalog.length > 0 && (
        <>
          <Text style={styles.label}>{noun.Cap} model</Text>
          <SelectField
            testID="boardModelSelect"
            value={selectedCatalogName ?? CUSTOM}
            options={catalogOptions}
            onChange={onPickCatalog}
            placeholder={`Select a ${noun.lower} model`}
          />
          <Text style={styles.hint}>
            Pick your board to fill its specs below. Choose “Custom” to enter them by hand, or press the pencil on any spec to tweak a stock
            board without retyping the rest. Only the values that affect the range estimate are editable. ESC model is a picker, and wheel
            size is just the number (for example 110).
          </Text>
        </>
      )}

      <Text style={styles.label}>Battery capacity (Wh)</Text>
      <TextInput
        testID="batteryCapacityInput"
        style={[styles.input, { color: textColor }]}
        placeholder="e.g. 432"
        placeholderTextColor={placeholderColor}
        keyboardType="decimal-pad"
        autoCorrect={false}
        value={capacityDraft}
        onChangeText={setCapacityDraft}
      />

      <Text style={styles.label}>{noun.Cap} weight (kg)</Text>
      <TextInput
        testID="boardWeightInput"
        style={[styles.input, { color: textColor }]}
        placeholder="e.g. 15"
        placeholderTextColor={placeholderColor}
        keyboardType="decimal-pad"
        autoCorrect={false}
        value={weightDraft}
        onChangeText={setWeightDraft}
      />

      {specFieldsFor(selectedDeviceBrand).map((field) => (
        <View key={field.key}>
          <View style={styles.fieldLabelRow}>
            <Text style={styles.label}>{field.label}</Text>
            {!specFieldsEditable && (
              <PressableScale
                testID={`${field.testID}Edit`}
                onPress={startOverride}
                hitSlop={8}
                style={styles.editButton}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${field.label}`}>
                <Pencil size={14} color={accentColor} />
                <Text style={[styles.editText, { color: accentColor }]}>Edit</Text>
              </PressableScale>
            )}
          </View>
          {field.kind === 'select' ? (
            <SelectField
              testID={field.testID}
              value={specDrafts[field.key] || null}
              options={field.options ?? ESC_MODEL_OPTIONS}
              onChange={(v) => setSpecDraft(field.key, v)}
              placeholder={field.placeholder}
              disabled={!specFieldsEditable}
            />
          ) : (
            <TextInput
              testID={field.testID}
              style={[styles.input, { color: textColor }, !specFieldsEditable && styles.inputReadOnly]}
              placeholder={field.placeholder}
              placeholderTextColor={placeholderColor}
              keyboardType={field.keyboardType}
              autoCapitalize={field.autoCapitalize}
              autoCorrect={false}
              editable={specFieldsEditable}
              value={specDrafts[field.key]}
              onChangeText={(v) => setSpecDraft(field.key, v)}
            />
          )}
        </View>
      ))}

      {saveError != null && <Text style={styles.error}>{saveError}</Text>}

      <PressableScale style={[styles.button, { backgroundColor: accentColor }]} onPress={save}>
        <Text style={styles.buttonText}>Save estimate inputs</Text>
      </PressableScale>
      {saved && (
        <View style={styles.savedRow}>
          <Text style={[styles.status, { color: good }]}>Saved. New estimates use these values.</Text>
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  cardGap: { gap: 8 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  hint: { fontSize: 12, opacity: 0.55, lineHeight: 16 },
  deviceRow: { marginTop: 4 },
  deviceRowContent: { gap: 6, paddingRight: 4 },
  devicePill: { borderRadius: 20, borderWidth: 1.5, paddingVertical: 6, paddingHorizontal: 12, maxWidth: 160 },
  devicePillText: { fontSize: 12, fontWeight: '600' },
  label: { fontSize: 13, marginTop: 10, marginBottom: 4, opacity: 0.8 },
  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editButton: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, marginBottom: 4 },
  editText: { fontSize: 12, fontWeight: '600' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#8884', borderRadius: 10, padding: 12, fontSize: 15 },
  inputReadOnly: { opacity: 0.5 },
  button: { marginTop: 16, borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600' },
  error: { fontSize: 12, color: '#e5484d', marginTop: 8 },
  savedRow: { flexDirection: 'row', alignItems: 'center' },
  status: { fontSize: 13, marginTop: 10 },
});
