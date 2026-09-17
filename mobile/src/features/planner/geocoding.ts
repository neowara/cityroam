// Address search for the trip planner via Komoot's Photon — free, no API
// key, OSM-based like the rest of this app's free/self-hosted stack (OpenFreeMap
// tiles, self-hosted OSRM, keyless Open-Meteo). Photon is purpose-built for
// search-as-you-type (its own README: "You are welcome to use the API for your
// project as long as the number of requests stay in a reasonable limit"), unlike
// Nominatim (used here previously), whose usage policy explicitly discourages
// per-keystroke/autocomplete-style queries — that mismatch was a real, self-imposed
// limitation, not a technical constraint: this app's own address box had no live
// suggestions purely because Nominatim's own policy ruled that out.

const PHOTON_SEARCH_URL = 'https://photon.komoot.io/api/';

// Photon can return several plausible matches for an ambiguous/partial query -- shown
// as a live-updating pick list as the rider types, not committed to until they tap one.
const MAX_RESULTS = 5;

export type GeocodeResult = {
  lat: number;
  lon: number;
  // A human-readable label built from Photon's structured address fields (name,
  // street, city, ...), shown to the rider as "Destination: <displayName>" and in the
  // suggestion list — Photon has no single pre-joined "display_name" the way
  // Nominatim did, so this is assembled from whichever fields a given result has.
  displayName: string;
};

export class GeocodingError extends Error {}

type PhotonProperties = {
  name?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  state?: string;
  country?: string;
};

type PhotonFeature = {
  properties: PhotonProperties;
  geometry: { coordinates: [number, number] }; // [lon, lat], GeoJSON order
};

/** Joins whichever of Photon's structured address fields a result actually has, most
 * specific first, skipping duplicates (a result named "Kungsgatan" on a street also
 * named "Kungsgatan" shouldn't repeat itself). Never empty for a result Photon
 * returned at all -- every feature carries at least a name or a country. */
function buildDisplayName(props: PhotonProperties): string {
  const street = props.housenumber && props.street ? `${props.street} ${props.housenumber}` : props.street;
  const parts = [props.name, street, props.city, props.state, props.country];
  const seen = new Set<string>();
  const unique = parts.filter((p): p is string => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return unique.join(', ');
}

/** Forward-geocodes a free-text address to up to MAX_RESULTS candidate points, most
 * relevant first (Photon's own ranking). Throws GeocodingError with a message fit to
 * show the rider directly (no result found, or the request itself failed) rather than
 * a raw HTTP/parse error. Safe to call on every keystroke (debounced by the caller) --
 * see this module's own header comment for why, unlike the Nominatim search this
 * replaced. */
export async function searchAddress(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new GeocodingError('Type an address first.');

  const url = `${PHOTON_SEARCH_URL}?q=${encodeURIComponent(trimmed)}&limit=${MAX_RESULTS}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new GeocodingError("Couldn't reach address search. Check your connection.");
  }
  if (!resp.ok) throw new GeocodingError('Address search failed. Try again in a moment.');

  const raw = (await resp.json()) as { features?: PhotonFeature[] };
  const results = (raw.features ?? [])
    .map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      displayName: buildDisplayName(f.properties),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.displayName.length > 0);
  if (results.length === 0) throw new GeocodingError('No matching address found.');
  return results;
}
