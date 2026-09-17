import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map as MapLibreMap, type CameraRef } from '@maplibre/maplibre-react-native';
import { Plus, Minus } from 'lucide-react-native';

import { Text } from '@/components/Themed';
import { PressableScale } from '@/components/ui/PressableScale';
import { useAppTheme } from '@/lib/theme';
import { filterRouteSpikes, splitRouteGaps } from '@/features/rides/routeGeo';
import { buildDirectionArrowPoints, metersPerPixelAtLat, offsetPolylineByMeters, polylineLengthM } from '@/features/rides/routeGeometry';
import type { RoutePoint, Stop } from '@/features/rides/tripTypes';

const MIN_ZOOM = 3;
const MAX_ZOOM = 20;

// MapLibre + OpenFreeMap (free, no-API-key vector tiles).
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

// How far apart an out-and-back ride's outbound/return passes are drawn — in target
// screen pixels (converted to real-world meters per current zoom below), so the visual
// separation stays constant however far the map is zoomed. Baked directly into the line
// and arrow geometry (offsetPolylineByMeters) rather than the native `line-offset` paint
// property, so the two are guaranteed to coincide exactly — see offsetPolylineByMeters.
const LINE_OFFSET_PX_STOPS: [number, number][] = [
  [12, 2],
  [17, 5],
];
// A target screen-pixel offset converts to a huge real-world distance once zoomed out
// far enough (each pixel covers more ground) — without a cap, a route zoomed out to
// see a whole city would get shifted sideways by hundreds of meters, badly distorting
// it, since the offset was only ever meant to nudge a line to the other side of the
// same street it's already on. A street is a few meters wide at most, so anything
// beyond roughly half of that stops looking like "the same street, offset" — it's just
// wrong.
const MAX_LINE_OFFSET_M = 8;
// Screen-pixel spacing between arrows — matches what the old symbol-spacing: 80 (before
// arrows needed individual points for per-arrow coloring) gave for free: constant
// on-screen density at every zoom, converted to real-world meters per zoom level below.
const ARROW_SPACING_PX = 80;

function interpolateStops(stops: [number, number][], x: number): number {
  if (x <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [x0, y0] = stops[i - 1];
    const [x1, y1] = stops[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

export function TripMap({
  route,
  snappedRoute,
  stops,
  follow = false,
  currentPosition = null,
  currentPositionApproximate = false,
}: {
  route: RoutePoint[];
  snappedRoute?: { lat: number; lon: number }[] | null;
  stops: Stop[];
  // Live-trip mode: keep the camera centered on the rider as they move instead of
  // fitting bounds once and leaving the user to pan. Trip-detail view omits this and
  // keeps the fit-once behavior.
  follow?: boolean;
  currentPosition?: { lat: number; lon: number } | null;
  // True when currentPosition is a fallback (e.g. LiveTripModule's app-launch-cached
  // fix) rather than a real live GPS sample — rendered visually distinct (dimmer, no
  // white stroke) so an approximate position is never mistaken for a
  // fix, since it can be stale enough to show the rider on the wrong street.
  currentPositionApproximate?: boolean;
}) {
  const { accentColor } = useAppTheme();
  const cameraRef = useRef<CameraRef>(null);
  const hasFitBounds = useRef(false);
  // Tracks actual zoom (onRegionDidChange) so a +/- button press starts from wherever the user last left it, gesture or button.
  const [zoom, setZoom] = useState(15);
  // Direction arrows stay hidden at (or back at) the initial auto-fit view and only
  // show while zoomed in past it — a busy trip's default view is already crowded with
  // the route/markers, and the arrows only add real value once zoomed in enough to tell
  // outbound from return apart anyway. Computed fresh from the current zoom vs a fixed
  // baseline every render (not a one-way "has zoomed" latch), so zooming back out hides
  // them again. The initial fitBounds() call itself fires onRegionDidChange too (its
  // own animation counts as "movement"), so the baseline isn't locked in until the
  // camera has gone quiet for a bit — otherwise the tail end of that same animation
  // would get baked in as the baseline.
  const baselineZoomRef = useRef<number | null>(null);
  const baselineLockedRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );
  const handleRegionDidChange = (z: number) => {
    setZoom(z);
    if (baselineLockedRef.current) return;
    baselineZoomRef.current = z;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      baselineLockedRef.current = true;
    }, 600);
  };
  // 0.3 is comfortably above the small fluctuations onRegionDidChange reports on an
  // otherwise-still map (float jitter, not an actual zoom), while still well under a
  // single real zoom step (1.0).
  const showArrows = baselineLockedRef.current && baselineZoomRef.current != null && zoom > baselineZoomRef.current + 0.3;
  const step = (delta: number) => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + delta));
    cameraRef.current?.zoomTo(next, { duration: 200 });
    setZoom(next);
  };

  // Prefer the OSRM-road-matched route (raw GPS traces cut over buildings); falls back
  // to the raw route (spike-filtered here too, since only snappedRoute comes pre-filtered).
  const displayRoute = useMemo(
    () => (snappedRoute && snappedRoute.length >= 2 ? snappedRoute : filterRouteSpikes(route)),
    [snappedRoute, route],
  );

  // Memoized on the actual data, not recomputed every render — unmemoized literals made
  // Camera's fitBounds effect see a "changed" bounds on every unrelated re-render and keep re-snapping (map felt unpannable).
  const coordinates = useMemo(() => displayRoute.map((p) => [p.lon, p.lat]), [displayRoute]);
  // snappedRoute is OSRM street geometry with no timestamps, so gap-splitting only applies to the raw route.
  const isSnapped = !!(snappedRoute && snappedRoute.length >= 2);
  // Tried and reverted: detecting an out-and-back ride's retraced portion and
  // rendering it as its own sideways-offset line. Real production bug, twice: on
  // actual saved-trip geometry (not just the synthetic test routes it was tuned
  // against), the classifier fragmented a normal ~500-point route into 120+
  // alternating micro-segments, which rendered as visual noise instead of a route —
  // confirmed by pulling a real trip's route from the production database and running
  // it through the actual classifier directly, not guessed. No established, robust
  // technique for this turned up in research either — production GPS-tracking apps
  // (Strava and similar) generally don't attempt real geometric offset-splitting of
  // overlapping track segments, they rely on color/gradient alone, which is what
  // this file still does below (line-gradient + direction arrows). Removed rather
  // than re-tuned a third time — a working single line beats a fragile split one.
  const lineSegments = useMemo(
    () => (isSnapped ? [coordinates] : splitRouteGaps(filterRouteSpikes(route)).map((seg) => seg.map((p) => [p.lon, p.lat]))),
    [isSnapped, route, coordinates],
  );
  // Include stops in bounds too — one slightly off the matched road could land just outside a route-only fit.
  // Falls back to just currentPosition when there's no route yet at all (a trip that
  // just started, or hasn't recorded a point since the last app restart) — previously
  // required >= 2 route points before rendering ANYTHING, so the live map showed a
  // bare "No route recorded" placeholder instead of at least centering on the rider's
  // last known position, for however long it took the first couple of real route
  // points to land.
  const boundsPoints = useMemo(
    () => [...displayRoute, ...stops, ...(currentPosition ? [currentPosition] : [])],
    [displayRoute, stops, currentPosition],
  );
  const bounds = useMemo(() => (boundsPoints.length >= 1 ? computeBounds(boundsPoints) : null), [boundsPoints]);
  // Whether `bounds` reflects real recorded geometry (route/stops) rather than just the
  // currentPosition fallback above — a fallback-only bounds is a single padded point
  // (~111m box) that doesn't yet reflect the trip's actual extent.
  const hasRealGeometry = displayRoute.length > 0 || stops.length > 0;

  useEffect(() => {
    // fitBounds fires once per trip, not on every render — after that the user's own
    // pan/zoom is left alone, which is the entire point of a map you can move around.
    // Deliberately does NOT count as "the" fit while bounds is fallback-only (no real
    // route/stops yet): still centers the camera there immediately so the map isn't
    // blank, but leaves hasFitBounds unset so the first real bounds (once actual route
    // data lands) gets its own proper fit instead of the camera staying locked to a
    // tight ~111m box around wherever the fallback happened to point.
    if (bounds && cameraRef.current && !hasFitBounds.current) {
      if (hasRealGeometry) hasFitBounds.current = true;
      cameraRef.current.fitBounds(bounds, { padding: { top: 40, bottom: 40, left: 40, right: 40 } });
    }
  }, [bounds, hasRealGeometry]);

  // Live-trip follow: after the initial fit, keep the camera centered on the rider as
  // the current position advances. Only re-centers when the position actually moves
  // (the route array is a fresh reference every GPS sample, so keying off the position
  // itself avoids re-centering on every unrelated re-render). A manual pan/zoom is
  // respected because this only fires on a new position, not on user gestures.
  const followPos = follow ? currentPosition : null;
  useEffect(() => {
    if (!followPos || !cameraRef.current) return;
    cameraRef.current.easeTo({ center: [followPos.lon, followPos.lat], duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followPos?.lat, followPos?.lon]);

  // The route's line segments, each shifted sideways by the same real-world-meter
  // amount (recomputed per current zoom, so the visual separation stays constant on
  // screen) — see offsetPolylineByMeters and the LINE_OFFSET_PX_STOPS comment above.
  // The direction arrows below interpolate directly along these same offset
  // coordinates rather than the raw route, which is what guarantees they land exactly
  // on top of the rendered line instead of beside it.
  const offsetSegments = useMemo(() => {
    const lat0 = displayRoute[0]?.lat ?? 0;
    const offsetM = Math.min(metersPerPixelAtLat(lat0, zoom) * interpolateStops(LINE_OFFSET_PX_STOPS, zoom), MAX_LINE_OFFSET_M);
    return lineSegments.filter((seg) => seg.length >= 2).map((seg) => offsetPolylineByMeters(seg as [number, number][], offsetM));
  }, [lineSegments, zoom, displayRoute]);

  // Always a valid Feature, never null: the GeoJSONSource below must stay mounted from
  // first render with SOME geometry (even empty) rather than appearing for the first
  // time already carrying real data — maplibre-react-native has a known bug where a
  // source+layer pair that mounts with data already present silently fails to render
  // (confirmed against the installed version via its GitHub issue tracker). Feeding an
  // empty GeometryCollection until real coordinates exist, then only ever updating the
  // `data` prop in place, avoids that source+layer-added-simultaneously race.
  const lineGeoJson: GeoJSON.Feature = useMemo(() => {
    return {
      type: 'Feature',
      properties: {},
      geometry:
        offsetSegments.length > 0
          ? { type: 'MultiLineString', coordinates: offsetSegments }
          : { type: 'GeometryCollection', geometries: [] },
    } as GeoJSON.Feature;
  }, [offsetSegments]);

  // One Point feature per direction arrow, each carrying the progress/rotate it needs
  // to color and orient itself independently of the line layer — see the arrow Layer's
  // comment below for why line-progress (what the line's own gradient uses) can't be
  // reused here. Spacing is computed in real-world meters from the current `zoom` (not
  // fixed meters), so arrow density stays visually constant at every zoom. Progress is
  // tracked cumulatively across all gap-split segments (not reset per segment) to match
  // how line-progress measures distance across the whole MultiLineString feature.
  const arrowGeoJson: GeoJSON.FeatureCollection = useMemo(() => {
    const lat0 = displayRoute[0]?.lat ?? 0;
    const spacingM = metersPerPixelAtLat(lat0, zoom) * ARROW_SPACING_PX;
    const totalRouteDistanceM = offsetSegments.reduce((sum, seg) => sum + polylineLengthM(seg), 0);
    let distanceBeforeM = 0;
    const features = offsetSegments.flatMap((seg) => {
      const arrows = buildDirectionArrowPoints(seg, spacingM, distanceBeforeM, totalRouteDistanceM);
      distanceBeforeM += polylineLengthM(seg);
      return arrows.map((a) => ({
        type: 'Feature' as const,
        properties: { progress: a.progress, rotate: a.rotate },
        geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
      }));
    });
    return { type: 'FeatureCollection', features };
  }, [offsetSegments, zoom, displayRoute]);

  const startEndGeoJson: GeoJSON.FeatureCollection | null = useMemo(() => {
    if (!bounds) return null;
    // Anchored to the true first/last point of the route actually recorded (same as
    // the stops markers below, which have never used the offset line either) — not
    // wherever a rendered polyline happens to stop. A gap-dropped final segment (see
    // splitRouteGaps) used to leave the end marker sitting at the end of an EARLIER
    // surviving segment instead of where the ride actually ended, sometimes hundreds
    // of metres off. This costs at most MAX_LINE_OFFSET_M (8m) of visual misalignment
    // against the sideways-offset line on an out-and-back ride's return leg — a real,
    // accepted trade-off against a marker that can otherwise land far from the truth.
    const trueFirst = displayRoute[0];
    const trueLast = displayRoute[displayRoute.length - 1];
    return {
      type: 'FeatureCollection',
      features: [
        // No route recorded yet (bounds came from currentPosition/stops alone, see
        // above) — nothing to mark as start/end.
        ...(trueFirst && trueLast
          ? [
              {
                type: 'Feature' as const,
                properties: { kind: 'start' },
                geometry: { type: 'Point' as const, coordinates: [trueFirst.lon, trueFirst.lat] },
              },
              {
                type: 'Feature' as const,
                properties: { kind: 'end' },
                geometry: { type: 'Point' as const, coordinates: [trueLast.lon, trueLast.lat] },
              },
            ]
          : []),
        ...stops.map((s) => ({
          type: 'Feature' as const,
          properties: { kind: 'stop' },
          geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        })),
        // Live-trip only: a distinct marker at the rider's current position so the
        // followed map shows where they are right now, not just the route so far.
        // kind stays 'current' either way (existing size/color rules keep applying);
        // approximate is a separate property so the paint expression below can dim it.
        ...(followPos
          ? [
              {
                type: 'Feature' as const,
                properties: { kind: 'current', approximate: currentPositionApproximate },
                geometry: { type: 'Point' as const, coordinates: [followPos.lon, followPos.lat] },
              },
            ]
          : []),
      ],
    };
  }, [bounds, displayRoute, stops, followPos, currentPositionApproximate]);

  if (!bounds || !startEndGeoJson) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No route recorded for this trip.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* OSM's data license (ODbL) requires attribution — never disable it. */}
      <MapLibreMap
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE_URL}
        attribution
        onRegionDidChange={(e) => handleRegionDidChange(e.nativeEvent.zoom)}>
        <Camera ref={cameraRef} initialViewState={{ bounds, padding: { top: 40, bottom: 40, left: 40, right: 40 } }} />

        {/* Always mounted, even before any route data exists (lineGeoJson falls back to an
            empty GeometryCollection) — a source+layer pair that first mounts with real data
            already attached silently fails to render on Android (see the comment on
            lineGeoJson above). Mounting empty and only ever updating `data` afterward avoids
            that race entirely. */}
        <GeoJSONSource id="route" data={lineGeoJson} lineMetrics>
          <Layer
            type="line"
            id="route-line"
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{
              'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#22a55a', 1, '#e5484d'],
              'line-width': 4,
            }}
          />
        </GeoJSONSource>

        {/* Direction arrows — direction cue #2, redundant with the gradient on purpose
            (the gradient alone is subtle at a glance). One Point feature per arrow,
            each carrying its own progress/rotate (see buildDirectionArrowPoints):
            MapLibre's line-progress expression — what the line layer's own gradient
            above uses — only works inside line-gradient/line-z-offset, not a symbol
            layer's paint, so coloring each arrow to match the line-offset pass it sits
            on requires generating the points ourselves rather than letting the renderer
            auto-distribute symbols along the line (which is what the previous
            symbol-placement: 'line' version did, before per-arrow color was needed).
            Always mounted (same reasoning as the route source above), with its own
            dedicated source rather than sharing "route" — two Layer children under one
            GeoJSONSource mounting together was what broke the line layer's rendering
            during the original bug hunt; separate sources side-step that. */}
        <GeoJSONSource id="route-arrows" data={arrowGeoJson}>
          <Layer
            type="symbol"
            id="route-direction"
            // Hidden unless zoomed in past the initial auto-fit view (see showArrows
            // above) — a plain numeric prop on an already-mounted layer, not a
            // conditional unmount/remount, so it can't reintroduce the
            // source+layer-added-together rendering bug from earlier.
            minzoom={showArrows ? undefined : MAX_ZOOM + 1}
            layout={{
              'text-field': '▶',
              'text-size': 14,
              // MapLibre's default text font ("Open Sans Regular,Arial Unicode MS
              // Regular") isn't hosted by OpenFreeMap's glyph server (404s on every
              // range, including plain ASCII) — this style's own layers all use Noto
              // Sans, which OpenFreeMap does serve.
              'text-font': ['Noto Sans Regular'],
              'text-rotation-alignment': 'map',
              'text-rotate': ['get', 'rotate'],
              // Must be false: MapLibre's default keep-upright flips a symbol 180°
              // to keep it "readable" from the viewer's perspective, which would
              // silently point the return leg's arrows the wrong way — the whole
              // point here is showing true direction of travel, not legibility.
              'text-keep-upright': false,
              'text-allow-overlap': true,
              'text-ignore-placement': true,
            }}
            paint={{
              // Matches the line-gradient stops above, driven by each point's own
              // progress property instead of line-progress (see the block comment).
              'text-color': ['interpolate', ['linear'], ['get', 'progress'], 0, '#22a55a', 1, '#e5484d'],
              'text-halo-color': 'rgba(0,0,0,0.65)',
              'text-halo-width': 1.2,
            }}
          />
        </GeoJSONSource>

        <GeoJSONSource id="points" data={startEndGeoJson}>
          <Layer
            type="circle"
            id="points-circle"
            paint={{
              'circle-radius': ['match', ['get', 'kind'], 'stop', 5, 'current', 8, 7],
              'circle-color': ['match', ['get', 'kind'], 'start', '#22a55a', 'end', '#e5484d', 'current', accentColor, '#f5c518'],
              // Dimmed when 'current' is a fallback (app-launch-cached fix, possibly
              // stale) rather than a real live GPS sample — an approximate position
              // should never look as confident as a one. 'approximate'
              // is only ever set on the 'current' feature; undefined elsewhere is
              // falsy, so every other marker kind is unaffected.
              'circle-opacity': ['case', ['==', ['get', 'approximate'], true], 0.55, 1],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#fff',
              'circle-stroke-opacity': ['case', ['==', ['get', 'approximate'], true], 0.55, 1],
            }}
          />
        </GeoJSONSource>
      </MapLibreMap>

      <View style={styles.zoomControls}>
        <PressableScale style={styles.zoomButton} onPress={() => step(1)} hitSlop={8}>
          <Plus color="#fff" size={18} />
        </PressableScale>
        <View style={styles.zoomDivider} />
        <PressableScale style={styles.zoomButton} onPress={() => step(-1)} hitSlop={8}>
          <Minus color="#fff" size={18} />
        </PressableScale>
      </View>
    </View>
  );
}

function computeBounds(route: { lat: number; lon: number }[]): [number, number, number, number] {
  let minLat = route[0].lat;
  let maxLat = route[0].lat;
  let minLon = route[0].lon;
  let maxLon = route[0].lon;
  for (const p of route) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  // A single-point or near-zero-area bbox makes fitBounds zoom in absurdly far — pad it.
  const latPad = Math.max((maxLat - minLat) * 0.1, 0.001);
  const lonPad = Math.max((maxLon - minLon) * 0.1, 0.001);
  return [minLon - lonPad, minLat - latPad, maxLon + lonPad, maxLat + latPad];
}

const styles = StyleSheet.create({
  container: { height: 260, borderRadius: 14, overflow: 'hidden' },
  empty: { height: 120, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#8882' },
  emptyText: { fontSize: 12, opacity: 0.5 },
  zoomControls: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    overflow: 'hidden',
  },
  zoomButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  zoomDivider: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.3)' },
});
