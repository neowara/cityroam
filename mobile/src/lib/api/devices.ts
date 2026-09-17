import { request } from '@/lib/api/client';

// Per-device estimate parameters — battery capacity and
// board weight, both previously phone-local-only (AsyncStorage, no device scoping);
// now backed by GET/PUT /devices/{deviceId}/settings so switching boards in the app
// picks up that board's own saved values instead of whichever board was last edited.
// The board spec-sheet fields + friendly name ride the same row.
// Multibrand: brand/wheelDiameterMm/driveType
// are the structured physics-relevant fields the backend reads; wheelType/escModel/
// truckSizeInches stay informational.
export type DeviceSetting = {
  deviceId: string;
  updatedAt: string;
  deviceName: string | null;
  batteryCapacityWh: number | null;
  boardWeightKg: number | null;
  cellConfig: string | null;
  packNominalVoltageV: number | null;
  motorPowerW: number | null;
  escModel: string | null;
  wheelType: string | null;
  truckSizeInches: number | null;
  brand: string | null;
  wheelDiameterMm: number | null;
  driveType: string | null;
};

// The PUT endpoint is a full replace, not a merge patch — omitting a field sends it as
// null and clears whatever was saved there before (backend/app/services/devices.py's
// generic _upsert dumps every field of the payload). Callers must always send every
// field together, even when only changing one.
export type DeviceSettingUpsert = {
  deviceName: string | null;
  batteryCapacityWh: number | null;
  boardWeightKg: number | null;
  cellConfig: string | null;
  packNominalVoltageV: number | null;
  motorPowerW: number | null;
  escModel: string | null;
  wheelType: string | null;
  truckSizeInches: number | null;
  brand: string | null;
  wheelDiameterMm: number | null;
  driveType: string | null;
};

// One known board configuration from GET /devices/catalog — the
// app-level catalog the settings picker renders so a rider can resolve their spec
// fields from a known config instead of typing free text. Multibrand: every
// entry is brand-tagged and carries the structured wheelDiameterMm/driveType fields.
export type BoardCatalogEntry = {
  catalogId: string;
  name: string;
  brand: string;
  cellConfig: string;
  packNominalVoltageV: number;
  motorPowerW: number;
  escModel: string;
  wheelType: string;
  wheelDiameterMm: number;
  driveType: string;
  truckSizeInches: number | null;
};

// Known product families. The account's
// productFamilies allow-list gates which catalog + pairing UI a user sees; each family
// maps to a device brand (tynee/navee) used to filter the catalog. A "custom" device
// outside any known family is always permitted regardless of this list.
export const PRODUCT_FAMILIES = {
  tynee: 'Tynee',
  navee: 'NAVEE',
} as const;

export type ProductFamily = keyof typeof PRODUCT_FAMILIES;

// The brand a device is assumed to be when none is stored (legacy pre-multibrand
// pairings) and the brand the Tuya BLE pairing path always produces — that path only
// ever pairs Tynee boards (see deviceLink), so 'tynee' is an accurate default, not a
// guess. Shared constant so the magic string isn't duplicated across deviceLink and
// the settings pairing gate (code-review findings). Brand keys == family keys.
export const DEFAULT_BRAND = 'tynee' as const;

export const devicesApi = {
  getDeviceSettings: (deviceId: string) => request<DeviceSetting | null>(`/devices/${encodeURIComponent(deviceId)}/settings`),

  putDeviceSettings: (deviceId: string, body: DeviceSettingUpsert) =>
    request<DeviceSetting>(`/devices/${encodeURIComponent(deviceId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  // brand filters the catalog to one family (tynee/navee) so a Tynee device only ever
  // shows Tynee boards and a NAVEE device only NAVEE boards. Omitted → all brands.
  getBoardCatalog: (brand?: string) =>
    request<{ catalog: BoardCatalogEntry[] }>(`/devices/catalog${brand ? `?brand=${encodeURIComponent(brand)}` : ''}`),
};
