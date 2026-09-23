// Point-to-point trip planner. Current location → a map-tapped or
// address-searched destination, routed server-side (self-hosted OSRM + Open-Meteo
// elevation + weather) with a plain-language verdict per mode ("Doable" / "Cutting it
// close" / "Not enough charge"). The route polyline comes back decimated server-side
// and is drawn on the map; the elevation profile renders as a VoltageGraph-style
// gifted-charts area chart.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, TextInput, View, type NativeSyntheticEvent } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map as MapLibreMap, type CameraRef, type PressEvent } from '@maplibre/maplibre-react-native';
import { useMutation } from '@tanstack/react-query';
import {
  BatteryMedium,
  CloudRain,
  ExternalLink,
  LocateFixed,
  MapPin,
  Mountain,
  Route as RouteIcon,
  Search,
  TrendingUp,
  Wind,
} from 'lucide-react-native';

import { Text, useThemeColor } from '@/components/Themed';
import { BatteryLiveSwitch } from '@/features/device/components/BatteryLiveSwitch';
import { Card } from '@/components/ui/Card';
import { ElevationChart } from '@/features/rides/components/ElevationChart';
import { ModeText } from '@/components/ui/ModeText';
import { PressableScale } from '@/components/ui/PressableScale';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { fontStyleFor, useAppTheme } from '@/lib/theme';
import { decodeMode, MODE_ICONS, MODE_META, type Mode } from '@/lib/mode';
import { reachabilityVerdict, VERDICT_META } from '@/lib/reachability';
import { api } from '@/lib/api';
import type { DestinationRangeResult } from '@/lib/api/rangeEstimate';
import { GeocodingError, searchAddress, type GeocodeResult } from '@/features/planner/geocoding';
import { useTripDeviceFilter } from '@/features/device/deviceFilter';
import { useDeviceProfileFor } from '@/features/device/deviceProfile';
import { resolveBatteryForScenario, useLiveRiderWeightKg, useSnapshot, type BatteryScenario } from '@/lib/queries';
import { compassDirection, weatherMeta } from '@/lib/weather';
import { mirrorRouteForRoundTrip, totalClimbM } from '@/features/rides/elevationProfile';
import { computeBounds } from '@/features/rides/routeGeometry';
import { getCachedLaunchLocation, refreshLaunchLocation, subscribeLaunchLocation } from '@/features/rides/launchLocation';
import { useDeviceNoun } from '@/features/device/deviceNoun';

// Same OpenFreeMap vector style as TripMap.
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// Initial view before a location is known (and the fallback when permission is denied) —
// a broad Stockholm-area default so the picker isn't a blank world view on first open.
const DEFAULT_BOUNDS: [number, number, number, number] = [17.85, 59.2, 18.35, 59.5];

// How long to wait after the rider stops typing before firing a live suggestion
// request — long enough that a fast typist's keystrokes coalesce into one request,
// short enough that suggestions still feel immediate.
const ADDRESS_SUGGEST_DEBOUNCE_MS = 300;
// Shortest query worth suggesting on — a couple of stray characters matches too much
// to be useful and isn't worth a request.
const ADDRESS_SUGGEST_MIN_LENGTH = 3;

type LatLon = { lat: number; lon: number };

export default function PlannerScreen() {
  const noun = useDeviceNoun();
  const { accentColor, font } = useAppTheme();
  const axisTextColor = useThemeColor({}, 'text');
  const inkDim = useThemeColor({}, 'inkDim');
  const inkFaint = useThemeColor({}, 'inkFaint');
  const line = useThemeColor({}, 'line');
  const textColor = useThemeColor({}, 'text');
  const placeholderColor = useThemeColor({ light: '#888', dark: '#777' }, 'text');

  const { deviceId } = useTripDeviceFilter();
  const { rideModes } = useDeviceProfileFor(deviceId);
  const snapshot = useSnapshot();
  const liveRiderWeightKg = useLiveRiderWeightKg();

  // Starts from the cached launch fix on first open (mirrors the auto-tracking default).
  const [start, setStart] = useState<LatLon | null>(() => {
    const cached = getCachedLaunchLocation();
    return cached ? { lat: cached.lat, lon: cached.lon } : null;
  });
  const [dest, setDest] = useState<LatLon | null>(null);
  // Only set when dest came from the address search box below, not a raw map tap —
  // the point row shows this in place of raw coordinates when present.
  const [destAddress, setDestAddress] = useState<string | null>(null);
  const [addressQuery, setAddressQuery] = useState('');
  const [addressSearching, setAddressSearching] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  // Live suggestions as the rider types (see the debounced effect below), or the
  // explicit search's own candidate matches -- shown as a pick list rather than
  // silently committing to the top guess, since an ambiguous query (a street name
  // that exists in several towns) can otherwise land you somewhere unintended.
  const [addressResults, setAddressResults] = useState<GeocodeResult[]>([]);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [estimateResult, setEstimateResult] = useState<DestinationRangeResult | null>(null);
  // Whether the whole card reads as an out-and-back trip (default) or a one-way drop —
  // purely a display choice: the backend always returns both one-way and round-trip
  // figures per mode, so toggling this never needs a refetch.
  const [roundTrip, setRoundTrip] = useState(true);
  // The "By mode" card can judge each mode against the board's current charge or a
  // hypothetical full battery. This scenario is scoped to "By mode" ONLY — it drives a
  // separate byModeEstimate mutation and never touches the main estimateResult that
  // feeds "The route" consumption and the Plan-a-trip battery row, which always use the
  // smart live-or-last-known source ('current').
  const [byModeScenario, setByModeScenario] = useState<BatteryScenario>('current');
  // Result of the last By-mode-scenario estimate. Falls back to the main estimateResult
  // until the user first toggles a scenario, so the card shows current-charge verdicts
  // right after "Estimate trip" without an extra round-trip.
  const [byModeResult, setByModeResult] = useState<DestinationRangeResult | null>(null);

  const cameraRef = useRef<CameraRef>(null);
  const [mapReady, setMapReady] = useState(false);
  // The map sits inside the screen's outer ScrollView, which otherwise competes for the
  // same drag gesture -- disabling the ScrollView for the duration of a touch that
  // started on the map hands the whole gesture to MapLibre instead of splitting it.
  const [mapTouchActive, setMapTouchActive] = useState(false);

  // The map is interactive from first render (even with no start yet) so the user can
  // tap a destination while location permission is still being resolved.
  const onMapPress = useCallback((e: NativeSyntheticEvent<PressEvent>) => {
    const [lon, lat] = e.nativeEvent.lngLat;
    setDest({ lat, lon });
    setDestAddress(null); // a raw map tap is coordinate-only, not the last searched address
    setAddressResults([]); // a map tap supersedes any pending address pick list
    setEstimateResult(null); // the old estimate no longer matches the new destination
  }, []);

  // The planner does NOT fire its own getCurrentPositionAsync on mount — the app takes
  // exactly ONE single GPS fix at launch (see lib/launchLocation.ts) and caches it.
  // This screen reads that shared cache so it shows the rider's position instantly,
  // without duplicating a GPS acquisition and without running a continuous watch while
  // idle.
  const applyLaunchLocation = useCallback((loc: { lat: number; lon: number } | null) => {
    if (!loc) return;
    setStart({ lat: loc.lat, lon: loc.lon });
    setEstimateResult(null);
  }, []);

  // If the one-shot launch fix hadn't landed when this opened, apply it the moment it does.
  useEffect(() => {
    if (getCachedLaunchLocation()) return;
    const unsubscribe = subscribeLaunchLocation((loc) => {
      if (loc) applyLaunchLocation(loc);
    });
    return unsubscribe;
  }, [applyLaunchLocation]);

  // The "locate me" button takes a fresh one-shot fix (updating the shared cache) rather
  // than a per-screen lookup — same single-fix discipline as app launch.
  const locateStart = useCallback(async () => {
    setLocating(true);
    setLocationError(null);
    const loc = await refreshLaunchLocation();
    if (loc) {
      setStart({ lat: loc.lat, lon: loc.lon });
      setEstimateResult(null);
    } else {
      setLocationError('Location permission is needed to use your current position as the start.');
    }
    setLocating(false);
  }, []);

  // Live suggestions as the rider types — Photon (lib/geocoding.ts) is built for
  // exactly this ("search-as-you-type"), unlike Nominatim (used here previously),
  // whose usage policy explicitly ruled it out. Debounced so a fast typist doesn't
  // fire a request per keystroke, and only for a real partial address (a couple of
  // stray characters isn't worth a request). Silent on failure/no-match — an empty
  // dropdown while still typing isn't an error; a genuinely failed search is only
  // surfaced via the explicit button/submit (handleAddressSearch) below.
  useEffect(() => {
    const trimmed = addressQuery.trim();
    // Below the threshold, simply don't fetch — the render below already gates the
    // dropdown on the same length check, so stale results from a longer query just
    // typed over stay harmlessly unrendered rather than needing to be cleared here
    // (clearing state synchronously in an effect body is exactly the anti-pattern
    // React's own set-state-in-effect rule flags).
    if (trimmed.length < ADDRESS_SUGGEST_MIN_LENGTH) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchAddress(trimmed)
        .then((results) => {
          if (!cancelled) setAddressResults(results);
        })
        .catch(() => {
          if (!cancelled) setAddressResults([]);
        });
    }, ADDRESS_SUGGEST_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [addressQuery]);

  const handleAddressSearch = useCallback(async () => {
    if (!addressQuery.trim() || addressSearching) return;
    setAddressSearching(true);
    setAddressError(null);
    setAddressResults([]);
    try {
      const results = await searchAddress(addressQuery);
      // A single unambiguous match can be committed directly; more than one means the
      // query was ambiguous and the rider should pick which place they meant.
      if (results.length === 1) {
        setDest({ lat: results[0].lat, lon: results[0].lon });
        setDestAddress(results[0].displayName);
        setEstimateResult(null);
      } else {
        setAddressResults(results);
      }
    } catch (err) {
      setAddressError(err instanceof GeocodingError ? err.message : 'Address search failed.');
    } finally {
      setAddressSearching(false);
    }
  }, [addressQuery, addressSearching]);

  const selectAddressResult = useCallback((result: GeocodeResult) => {
    setDest({ lat: result.lat, lon: result.lon });
    setDestAddress(result.displayName);
    setAddressResults([]);
    setEstimateResult(null);
  }, []);

  // Fit the map to start + destination (+ route once estimated). Only refits when the
  // actual points change, so the user's own pan/zoom is left alone between taps.
  const bounds = useMemo(() => {
    const pts: LatLon[] = [];
    if (start) pts.push(start);
    if (dest) pts.push(dest);
    if (estimateResult?.snappedRoute && estimateResult.snappedRoute.length > 0) pts.push(...estimateResult.snappedRoute);
    return computeBounds(pts);
  }, [start, dest, estimateResult]);

  useEffect(() => {
    if (!mapReady || !bounds || !cameraRef.current) return;
    cameraRef.current.fitBounds(bounds, { padding: { top: 48, bottom: 48, left: 48, right: 48 } });
  }, [mapReady, bounds]);

  // The main estimate always uses the smart battery source ('current'): live BLE when
  // the board is connected, else the device's last-known telemetry. This feeds "The
  // route" consumption, the elevation/weather cards, and the Plan-a-trip battery row —
  // none of which are ever affected by the "By mode" scenario toggle.
  const estimate = useMutation({
    mutationFn: async () => {
      if (!start || !dest) throw new Error('Pick a start and destination first.');
      // liveRiderWeightKg is the raw Health Connect rider-weight reading — the same
      // figure the dashboard's live estimate uses (useLiveRiderWeightKg). The backend
      // combines it with the persisted/default rider weight and the device's saved
      // board weight itself.
      // batteryCapacityWh is deliberately NOT sent here -- when deviceId is set, the
      // endpoint already resolves the device's own saved capacity server-side, so
      // there's nothing left for the client to add.
      const { batteryPct, voltageV } = await resolveBatteryForScenario('current');
      return api.rangeEstimateToDestination({
        startLat: start.lat,
        startLon: start.lon,
        destLat: dest.lat,
        destLon: dest.lon,
        batteryPct: batteryPct ?? undefined,
        voltageV: voltageV ?? undefined,
        liveRiderWeightKg: liveRiderWeightKg ?? undefined,
        deviceId,
      });
    },
    onSuccess: (data) => {
      setEstimateResult(data);
      // A fresh main estimate resets the By-mode card back to the current-charge
      // scenario so its verdicts don't silently stay on a stale full-battery run.
      setByModeScenario('current');
      setByModeResult(null);
    },
  });

  // The "By mode" card's own scenario estimate — independent of the main estimate so
  // toggling Full/Current battery here only re-judges the per-mode verdicts and never
  // touches "The route" consumption or the Plan-a-trip battery row.
  const byModeEstimate = useMutation({
    mutationFn: async (scenario: BatteryScenario) => {
      if (!start || !dest) throw new Error('Pick a start and destination first.');
      const { batteryPct, voltageV } = await resolveBatteryForScenario(scenario);
      return api.rangeEstimateToDestination({
        startLat: start.lat,
        startLon: start.lon,
        destLat: dest.lat,
        destLon: dest.lon,
        batteryPct: batteryPct ?? undefined,
        voltageV: voltageV ?? undefined,
        liveRiderWeightKg: liveRiderWeightKg ?? undefined,
        deviceId,
      });
    },
    onSuccess: (data) => setByModeResult(data),
  });

  const batteryPct = snapshot.data?.batteryPct ?? null;
  const batteryUnknown = batteryPct == null;

  // GeoJSON sources for the map.
  const pointFeatures = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    if (start) {
      features.push({
        type: 'Feature',
        properties: { kind: 'start' },
        geometry: { type: 'Point', coordinates: [start.lon, start.lat] },
      });
    }
    if (dest) {
      features.push({
        type: 'Feature',
        properties: { kind: 'dest' },
        geometry: { type: 'Point', coordinates: [dest.lon, dest.lat] },
      });
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [start, dest]);

  // Always a valid Feature, never null: the GeoJSONSource below must stay mounted from
  // first render with SOME geometry (even empty) rather than appearing for the first time
  // already carrying real data — maplibre-react-native has a known bug where a source+layer
  // pair added to an already-mounted map together in one native commit silently fails to
  // render. Feeding an empty GeometryCollection until a real route exists avoids that race.
  const routeLine = useMemo<GeoJSON.Feature>(() => {
    const route = estimateResult?.snappedRoute;
    return {
      type: 'Feature',
      properties: {},
      geometry:
        route && route.length >= 2
          ? { type: 'LineString', coordinates: route.map((p) => [p.lon, p.lat]) }
          : { type: 'GeometryCollection', geometries: [] },
    } as GeoJSON.Feature;
  }, [estimateResult]);

  // The full round-trip elevation profile (out, then the same path mirrored back) when
  // the toggle is on -- built once and shared by both the climb figure and the chart
  // below, so they can never disagree with each other.
  const chartRoute = useMemo(() => {
    const route = estimateResult?.snappedRoute ?? [];
    return roundTrip ? mirrorRouteForRoundTrip(route) : route;
  }, [estimateResult, roundTrip]);

  const climbM = useMemo(() => (estimateResult ? totalClimbM(chartRoute) : null), [estimateResult, chartRoute]);
  const displayDistanceKm = estimateResult ? estimateResult.distanceKm * (roundTrip ? 2 : 1) : null;

  // Which mode's numbers "The route" card features for its consumption stat — the
  // board's own currently-selected drive mode when connected (most relevant to the
  // rider right now), falling back to Eco otherwise. "By mode" below still breaks out
  // every mode individually; this is just a single headline figure.
  const featuredMode: Mode = useMemo(() => {
    const raw = snapshot.data?.mode;
    if (!raw) return 'eco';
    const decoded = decodeMode(raw);
    return (rideModes as readonly string[]).includes(decoded) ? (decoded as Mode) : rideModes[0];
  }, [snapshot.data?.mode, rideModes]);

  const featuredModeData = estimateResult?.modes[featuredMode];
  const featuredArrivalPct = featuredModeData
    ? roundTrip
      ? featuredModeData.estimatedRoundTripArrivalBatteryPct
      : featuredModeData.estimatedArrivalBatteryPct
    : null;
  const consumptionPct =
    estimateResult?.batteryPct != null && featuredArrivalPct != null ? estimateResult.batteryPct - featuredArrivalPct : null;
  const consumptionPerKm = consumptionPct != null && displayDistanceKm && displayDistanceKm > 0 ? consumptionPct / displayDistanceKm : null;

  const weather = estimateResult?.weather;
  const weatherIconMeta = weather?.weatherCodes?.[0] != null ? weatherMeta(weather.weatherCodes[0]) : null;

  const openInGoogleMaps = useCallback(() => {
    if (!start || !dest) return;
    // No dedicated e-scooter travel mode on Google Maps -- bicycling is the closest
    // available match (road-legal, avoids highways), a judgment call documented here
    // rather than defaulting to driving directions.
    const url = `https://www.google.com/maps/dir/?api=1&origin=${start.lat},${start.lon}&destination=${dest.lat},${dest.lon}&travelmode=bicycling`;
    Linking.openURL(url).catch(() => {});
  }, [start, dest]);

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} scrollEnabled={!mapTouchActive}>
        <ScreenHeader icon={MapPin} title="Route planner" />

        <Card style={styles.cardGap}>
          <View style={styles.cardHead}>
            <RouteIcon size={16} color={accentColor} />
            <Text style={[styles.cardTitle, fontStyleFor(font)]}>Plan a trip</Text>
          </View>
          <Text style={[styles.hint, { color: inkDim }]}>
            Tap the map, or search an address, to set a destination. Your current location is the start.
          </Text>

          <View style={styles.addressRow}>
            <TextInput
              style={[styles.addressInput, { color: textColor, borderColor: line }]}
              placeholder="Search an address…"
              placeholderTextColor={placeholderColor}
              value={addressQuery}
              onChangeText={setAddressQuery}
              onSubmitEditing={handleAddressSearch}
              returnKeyType="search"
              autoCorrect={false}
            />
            <PressableScale
              style={[
                styles.addressButton,
                { backgroundColor: accentColor },
                (addressSearching || !addressQuery.trim()) && styles.estimateButtonDisabled,
              ]}
              disabled={addressSearching || !addressQuery.trim()}
              onPress={handleAddressSearch}>
              <Search color="#fff" size={18} />
            </PressableScale>
          </View>
          {addressError && <Text style={[styles.note, { color: '#e5484d' }]}>{addressError}</Text>}

          {addressResults.length > 0 && addressQuery.trim().length >= ADDRESS_SUGGEST_MIN_LENGTH && (
            <View style={[styles.addressResultsList, { borderColor: line }]}>
              {addressResults.map((result, i) => (
                <PressableScale
                  key={`${result.lat},${result.lon}`}
                  style={[styles.addressResultRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: line }]}
                  onPress={() => selectAddressResult(result)}>
                  <Text style={[styles.addressResultText, { color: inkDim }]} numberOfLines={2}>
                    {result.displayName}
                  </Text>
                </PressableScale>
              ))}
            </View>
          )}

          <View
            style={[styles.mapWrap, { borderColor: line }]}
            onTouchStart={() => setMapTouchActive(true)}
            onTouchEnd={() => setMapTouchActive(false)}
            onTouchCancel={() => setMapTouchActive(false)}>
            <MapLibreMap
              style={StyleSheet.absoluteFill}
              mapStyle={MAP_STYLE_URL}
              attribution
              onPress={onMapPress}
              onRegionDidChange={() => {}}
              onDidFinishLoadingMap={() => setMapReady(true)}>
              <Camera
                ref={cameraRef}
                initialViewState={{ bounds: DEFAULT_BOUNDS, padding: { top: 48, bottom: 48, left: 48, right: 48 } }}
              />

              <GeoJSONSource id="planner-route" data={routeLine}>
                <Layer
                  type="line"
                  id="planner-route-line"
                  layout={{ 'line-join': 'round', 'line-cap': 'round' }}
                  paint={{ 'line-color': accentColor, 'line-width': 4 }}
                />
              </GeoJSONSource>

              <GeoJSONSource id="planner-points" data={pointFeatures}>
                <Layer
                  type="circle"
                  id="planner-points-circle"
                  paint={{
                    'circle-radius': 7,
                    'circle-color': ['match', ['get', 'kind'], 'start', '#22a55a', '#e5484d'],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#fff',
                  }}
                />
              </GeoJSONSource>
            </MapLibreMap>

            {!dest && (
              <View style={styles.mapHint} pointerEvents="none">
                <Text style={styles.mapHintText}>Tap the map to set a destination</Text>
              </View>
            )}

            {locating && (
              <View style={styles.mapLoadingOverlay} pointerEvents="none">
                <ActivityIndicator color="#fff" size="large" />
              </View>
            )}

            <PressableScale style={styles.locateButton} onPress={locateStart} disabled={locating} hitSlop={8}>
              <LocateFixed color="#fff" size={18} />
            </PressableScale>
          </View>

          <View style={styles.pointsRow}>
            <View style={styles.pointRow}>
              <View style={[styles.pointDot, { backgroundColor: '#22a55a' }]} />
              <Text style={[styles.pointText, { color: inkDim }]}>
                {start ? 'Current location' : locating ? 'Getting your location…' : 'No start location'}
              </Text>
            </View>
            <View style={styles.pointRow}>
              <View style={[styles.pointDot, { backgroundColor: '#e5484d' }]} />
              <Text style={[styles.pointText, { color: inkDim }]} numberOfLines={2}>
                {dest
                  ? destAddress
                    ? `Destination: ${destAddress}`
                    : `${dest.lat.toFixed(4)}, ${dest.lon.toFixed(4)}`
                  : 'Tap the map to set a destination'}
              </Text>
            </View>
          </View>

          {locationError && <Text style={[styles.note, { color: '#e5484d' }]}>{locationError}</Text>}

          <View style={styles.batteryRow}>
            <BatteryMedium size={14} color={batteryUnknown ? inkFaint : accentColor} />
            <Text style={[styles.batteryText, { color: batteryUnknown ? inkFaint : inkDim }]}>
              {batteryUnknown ? `Connect your ${noun.lower} to base this on its battery` : `Battery ${Math.round(batteryPct)}%`}
            </Text>
          </View>

          <View style={styles.toggleRow}>
            <ToggleButton
              label="Round trip"
              active={roundTrip}
              accentColor={accentColor}
              inkDim={inkDim}
              onPress={() => setRoundTrip(true)}
            />
            <ToggleButton
              label="One way"
              active={!roundTrip}
              accentColor={accentColor}
              inkDim={inkDim}
              onPress={() => setRoundTrip(false)}
            />
          </View>

          <View style={styles.actionRow}>
            <PressableScale
              style={[
                styles.estimateButton,
                styles.actionFlex,
                { backgroundColor: accentColor },
                (!start || !dest) && styles.estimateButtonDisabled,
              ]}
              disabled={!start || !dest || estimate.isPending}
              onPress={() => estimate.mutate()}>
              <Text style={styles.estimateButtonText}>{estimate.isPending ? 'Estimating…' : 'Estimate trip'}</Text>
            </PressableScale>
            <PressableScale
              style={[styles.mapsButton, { borderColor: accentColor }, (!start || !dest) && styles.estimateButtonDisabled]}
              disabled={!start || !dest}
              onPress={openInGoogleMaps}
              accessibilityLabel="Open in Google Maps">
              <ExternalLink color={accentColor} size={18} />
            </PressableScale>
          </View>
        </Card>

        {estimate.isError && (
          <Card style={styles.cardGap}>
            <Text style={styles.errorText}>{describeError(estimate.error)}</Text>
          </Card>
        )}

        {estimateResult && (
          <>
            <Card style={styles.cardGap}>
              <View style={styles.cardHead}>
                <Mountain size={16} color={accentColor} />
                <Text style={[styles.cardTitle, fontStyleFor(font)]}>The route</Text>
              </View>
              <View style={styles.statsRow}>
                <View style={styles.stat}>
                  <Text style={[styles.statValue, fontStyleFor(font)]}>
                    {displayDistanceKm != null ? `${displayDistanceKm.toFixed(1)} km` : '—'}
                  </Text>
                  <Text style={[styles.statLabel, { color: inkFaint }]}>Distance{roundTrip ? ' (RT)' : ' (1-way)'}</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={[styles.statValue, fontStyleFor(font)]}>{climbM != null ? `${Math.round(climbM)} m` : '—'}</Text>
                  <Text style={[styles.statLabel, { color: inkFaint }]}>Climb{roundTrip ? ' (RT)' : ' (1-way)'}</Text>
                </View>
                <View style={styles.stat}>
                  <Text style={[styles.statValue, fontStyleFor(font)]}>
                    {consumptionPct != null ? `${Math.round(consumptionPct)}%` : '—'}
                  </Text>
                  <Text style={[styles.statLabel, { color: inkFaint }]}>Consumption</Text>
                  <Text style={[styles.statSub, { color: inkFaint }]}>
                    {consumptionPerKm != null ? `${consumptionPerKm.toFixed(1)}%/km` : ''} · <ModeText mode={featuredMode} />
                  </Text>
                </View>
              </View>
            </Card>

            <Card style={styles.cardGap}>
              <View style={styles.cardHead}>
                <TrendingUp size={16} color={accentColor} />
                <Text style={[styles.cardTitle, fontStyleFor(font)]}>Elevation profile</Text>
              </View>
              <ElevationChart
                route={chartRoute}
                accentColor={accentColor}
                axisTextColor={axisTextColor}
                unavailableReason={estimateResult?.elevationUnavailableReason}
              />
            </Card>

            {weather && (
              <Card style={styles.cardGap}>
                <View style={styles.cardHead}>
                  {weatherIconMeta ? <weatherIconMeta.Icon size={16} color={accentColor} /> : <Wind size={16} color={accentColor} />}
                  <Text style={[styles.cardTitle, fontStyleFor(font)]}>Conditions</Text>
                </View>
                {weatherIconMeta && (
                  <ConditionRow
                    Icon={weatherIconMeta.Icon}
                    label={weatherIconMeta.label}
                    value={weather.feelsLikeC != null ? `Feels like ${Math.round(weather.feelsLikeC)}°C` : ''}
                    inkDim={inkDim}
                    accentColor={accentColor}
                  />
                )}
                <ConditionRow
                  Icon={Wind}
                  label="Wind"
                  value={
                    weather.windSpeedMs != null
                      ? `${weather.windSpeedMs.toFixed(1)} m/s from ${compassDirection(weather.windDirectionDeg)} · factored into the estimate above`
                      : '—'
                  }
                  inkDim={inkDim}
                  accentColor={accentColor}
                />
                {weather.wetRoadChancePct != null && (
                  <ConditionRow
                    Icon={CloudRain}
                    label="Chance of wet roads"
                    value={`${Math.round(weather.wetRoadChancePct)}%`}
                    inkDim={inkDim}
                    accentColor={accentColor}
                  />
                )}
              </Card>
            )}

            <Card style={styles.cardGap}>
              <View style={styles.cardHead}>
                <BatteryMedium size={16} color={accentColor} />
                <Text style={[styles.cardTitle, fontStyleFor(font)]}>By mode</Text>
                <BatteryLiveSwitch
                  style={styles.cardHeadSwitch}
                  live={byModeScenario === 'current'}
                  onChange={(live) => {
                    const next: BatteryScenario = live ? 'current' : 'full';
                    setByModeScenario(next);
                    if (estimateResult) byModeEstimate.mutate(next);
                  }}
                />
              </View>
              {byModeEstimate.isPending && <ActivityIndicator size="small" color={accentColor} style={styles.byModeSpinner} />}
              {rideModes.map((m) => {
                const modeData = (byModeResult ?? estimateResult).modes[m];
                if (!modeData) return null;
                const verdict = reachabilityVerdict(modeData, roundTrip);
                const meta = VERDICT_META[verdict];
                const Icon = MODE_ICONS[m];
                const arrive = modeData.estimatedArrivalBatteryPct;
                const modeRoundTrip = modeData.estimatedRoundTripArrivalBatteryPct;
                return (
                  <View key={m} style={styles.modeRow}>
                    <View style={styles.modeLeft}>
                      <Icon size={16} color={MODE_META[m]?.color ?? '#8B93A1'} />
                      <ModeText mode={m} style={styles.modeLabel} />
                    </View>
                    <View style={styles.modeRight}>
                      <View style={[styles.verdictBadge, { borderColor: meta.color + '66', backgroundColor: meta.color + '1A' }]}>
                        <View style={[styles.verdictDot, { backgroundColor: meta.color }]} />
                        <Text style={[styles.verdictLabel, { color: meta.color }]}>{meta.label}</Text>
                      </View>
                      <Text style={[styles.modeDetail, { color: inkDim }]}>
                        {modeData.distanceKm != null ? `${modeData.distanceKm.toFixed(1)} km` : '— km'}
                        {arrive != null ? ` · arrive ${Math.round(arrive)}%` : ''}
                        {roundTrip && modeRoundTrip != null ? ` · back ${Math.round(modeRoundTrip)}%` : ''}
                      </Text>
                    </View>
                  </View>
                );
              })}
              <Text style={[styles.note, { color: inkFaint }]}>
                {byModeScenario === 'full'
                  ? 'Verdicts assume a full battery and that you ride the whole way in that mode.'
                  : batteryUnknown
                    ? VERDICT_META.unknown.description
                    : roundTrip
                      ? 'Verdicts assume you ride the whole way in that mode, one-way and back.'
                      : 'Verdicts assume you ride the whole way in that mode, one-way only.'}
              </Text>
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ToggleButton({
  label,
  active,
  accentColor,
  inkDim,
  onPress,
}: {
  label: string;
  active: boolean;
  accentColor: string;
  inkDim: string;
  onPress: () => void;
}) {
  return (
    <PressableScale
      style={[
        styles.toggleButton,
        { borderColor: active ? accentColor : inkDim + '55' },
        active && { backgroundColor: accentColor + '18' },
      ]}
      onPress={onPress}>
      <Text style={[styles.toggleButtonText, { color: active ? accentColor : inkDim }]}>{label}</Text>
    </PressableScale>
  );
}

function ConditionRow({
  Icon,
  label,
  value,
  inkDim,
  accentColor,
}: {
  Icon: typeof Wind;
  label: string;
  value: string;
  inkDim: string;
  accentColor: string;
}) {
  return (
    <View style={styles.conditionRow}>
      <Icon size={14} color={accentColor} />
      <Text style={[styles.conditionLabel, { color: inkDim }]}>{label}</Text>
      <Text style={[styles.conditionValue, { color: inkDim }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

/** Map the request() error message to something a rider can act on (400/503 from the
 * backend endpoint; anything else falls through to the raw message). */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg.startsWith('503')) return 'The routing service is unavailable right now. Try again shortly.';
    if (msg.startsWith('400')) return 'That destination looks too far for a trip. Pick somewhere closer.';
    if (msg.startsWith('401')) return 'Your session expired. Sign in again.';
    return msg;
  }
  return 'Something went wrong while estimating.';
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 110 },
  cardGap: { marginBottom: 14 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardHeadSwitch: { marginLeft: 'auto' },
  cardTitle: { fontSize: 16 },
  hint: { fontSize: 13 },
  addressRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  addressInput: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, fontSize: 14 },
  addressButton: { width: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  addressResultsList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, marginTop: 8, overflow: 'hidden' },
  addressResultRow: { paddingHorizontal: 12, paddingVertical: 10 },
  addressResultText: { fontSize: 13 },
  mapWrap: { height: 260, borderRadius: 14, overflow: 'hidden', borderWidth: 1, marginTop: 10 },
  mapHint: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  mapHintText: { color: '#fff', fontSize: 12 },
  mapLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locateButton: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointsRow: { gap: 6, marginTop: 8 },
  pointRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pointDot: { width: 10, height: 10, borderRadius: 5 },
  pointText: { fontSize: 12, flex: 1 },
  note: { fontSize: 12, marginTop: 4 },
  batteryRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  batteryText: { fontSize: 12, flex: 1, lineHeight: 16 },
  byModeSpinner: { alignSelf: 'flex-start', marginTop: 8 },
  toggleRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  toggleButton: { flex: 1, borderRadius: 10, borderWidth: 1.5, paddingVertical: 9, alignItems: 'center' },
  toggleButtonText: { fontSize: 13, fontWeight: '600' },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  actionFlex: { flex: 1 },
  estimateButton: {
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  estimateButtonDisabled: { opacity: 0.4 },
  estimateButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  mapsButton: {
    width: 48,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: { color: '#e5484d', fontSize: 13 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 4 },
  stat: { alignItems: 'center', gap: 2 },
  statValue: { fontSize: 20 },
  statLabel: { fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  statSub: { fontSize: 10 },
  conditionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  conditionLabel: { fontSize: 13, fontWeight: '500', width: 90 },
  conditionValue: { fontSize: 12, flex: 1 },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#8884',
  },
  modeLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  modeLabel: { fontSize: 14, fontWeight: '500' },
  modeRight: { alignItems: 'flex-end', gap: 3 },
  verdictBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  verdictDot: { width: 7, height: 7, borderRadius: 4 },
  verdictLabel: { fontSize: 11, fontWeight: '600' },
  modeDetail: { fontSize: 11 },
});
