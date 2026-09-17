import { useSession } from '@/features/auth/auth';
import { DEFAULT_BRAND, type ProductFamily } from '@/lib/api';

/**
 * What to call the thing the rider rides, in their own words.
 *
 * A Tynee is a board and a NAVEE is a scooter, and calling either one a "device" reads
 * like a manual. Exactly one product family is selectable at a time — nobody rides two
 * at once — so the noun is unambiguous and can be used throughout the UI.
 */
const NOUNS: Record<ProductFamily, { one: string; plural: string }> = {
  tynee: { one: 'Board', plural: 'Boards' },
  navee: { one: 'Scooter', plural: 'Scooters' },
};

export type DeviceNoun = {
  /** Capitalised, for a label or the start of a sentence: "Board". */
  Cap: string;
  /** Lower case, for mid-sentence use: "board". */
  lower: string;
  /** Capitalised plural: "Boards". */
  CapPlural: string;
  /** Lower case plural: "boards". */
  lowerPlural: string;
};

export function deviceNounFor(families: readonly string[]): DeviceNoun {
  const family = (families.find((f) => f in NOUNS) as ProductFamily | undefined) ?? DEFAULT_BRAND;
  const { one, plural } = NOUNS[family];
  return { Cap: one, lower: one.toLowerCase(), CapPlural: plural, lowerPlural: plural.toLowerCase() };
}

/** The noun for the signed-in account's product family. Re-renders when it changes. */
export function useDeviceNoun(): DeviceNoun {
  const { productFamilies } = useSession();
  return deviceNounFor(productFamilies);
}
