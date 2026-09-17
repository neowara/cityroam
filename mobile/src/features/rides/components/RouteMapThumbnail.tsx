import { useMemo } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map as MapLibreMap } from '@maplibre/maplibre-react-native';

import { Text } from '@/components/Themed';
import { useAppTheme } from '@/lib/theme';
import { filterRouteSpikes, splitRouteGaps } from '@/features/rides/routeGeo';

const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

type Point = { lat: number; lon: number };
type TimedPoint = Point & { timestampMs: number; speedKmh?: number };

/**
 * A real, small, non-interactive map — not the hand-drawn line-on-a-flat-box this
 * card used to show. Real-ride feedback: "the map on the start page has no actual
 * map, just the route." Gestures disabled (scrollEnabled/zoomEnabled/etc false) since
 * this is a preview leading to the real interactive map on tap, not a second map to
 * pan around on its own.
 */
export function RouteMapThumbnail({
  route,
  snappedRoute,
  width,
  height,
}: {
  route: TimedPoint[] | undefined;
  snappedRoute?: Point[] | null;
  width: DimensionValue;
  height: number;
}) {
  const { accentColor } = useAppTheme();
  // snappedRoute already comes off OSRM's own spike-filtered input; the raw-route
  // fallback still needs it applied here too (see lib/routeGeo.ts).
  const displayRoute = useMemo(
    () => (snappedRoute && snappedRoute.length >= 2 ? snappedRoute : filterRouteSpikes(route ?? [])),
    [snappedRoute, route],
  );

  const coordinates = useMemo(() => displayRoute.map((p) => [p.lon, p.lat]), [displayRoute]);
  const bounds = useMemo(() => (coordinates.length >= 2 ? computeBounds(coordinates) : null), [coordinates]);
  const isSnapped = !!(snappedRoute && snappedRoute.length >= 2);
  const lineSegments = useMemo(
    () => (isSnapped ? [coordinates] : splitRouteGaps(filterRouteSpikes(route ?? [])).map((seg) => seg.map((p) => [p.lon, p.lat]))),
    [isSnapped, route, coordinates],
  );

  // Falls back to an empty GeometryCollection rather than a MultiLineString with an empty
  // coordinates array — this source stays mounted even before real segments exist (see
  // TripMap.tsx's lineGeoJson for why), and an always-mounted source must never carry
  // degenerate geometry.
  const lineGeoJson: GeoJSON.Feature = useMemo(() => {
    const segments = lineSegments.filter((seg) => seg.length >= 2);
    return {
      type: 'Feature',
      properties: {},
      geometry: segments.length > 0 ? { type: 'MultiLineString', coordinates: segments } : { type: 'GeometryCollection', geometries: [] },
    } as GeoJSON.Feature;
  }, [lineSegments]);

  // Same start/end markers as the full TripMap, scaled down for a thumbnail — falls
  // back to an empty FeatureCollection (same always-mounted-source reasoning as
  // lineGeoJson above) rather than being null/omitted when there's no route yet.
  const startEndGeoJson: GeoJSON.FeatureCollection = useMemo(() => {
    if (coordinates.length === 0) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { kind: 'start' }, geometry: { type: 'Point', coordinates: coordinates[0] } },
        { type: 'Feature', properties: { kind: 'end' }, geometry: { type: 'Point', coordinates: coordinates[coordinates.length - 1] } },
      ],
    };
  }, [coordinates]);

  if (!bounds) {
    return (
      <View style={[styles.empty, { width, height }]}>
        <Text style={styles.emptyText}>No route recorded</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { width, height }]}>
      <MapLibreMap
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE_URL}
        // The MapLibre attribution control renders as a compact "i" info button that
        // reads as noise on a 44px ride thumbnail — hide it here (explicit user call).
        // The full interactive TripMap keeps OSM's ODbL attribution; this tiny
        // non-interactive preview is the deliberate exception.
        attribution={false}
        logo={false}
        compass={false}
        scaleBar={false}
        dragPan={false}
        touchZoom={false}
        doubleTapZoom={false}
        doubleTapHoldZoom={false}
        touchRotate={false}
        touchPitch={false}>
        <Camera initialViewState={{ bounds, padding: { top: 16, bottom: 16, left: 16, right: 16 } }} />
        <GeoJSONSource id="thumb-route" data={lineGeoJson}>
          <Layer
            type="line"
            id="thumb-route-line"
            layout={{ 'line-join': 'round', 'line-cap': 'round' }}
            paint={{
              'line-color': accentColor,
              'line-width': 3,
              // See TripMap.tsx's route-line layer for why: separates an out-and-back
              // ride's outbound/return passes without touching the geometry. Flat (not
              // zoom-interpolated) since this thumbnail has no zoom control — screen
              // pixels stay consistent regardless of whatever zoom the one-time bounds
              // fit lands on.
              'line-offset': 1.5,
            }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="thumb-points" data={startEndGeoJson}>
          <Layer
            type="circle"
            id="thumb-points-circle"
            paint={{
              // Same start=green/end=red scheme as TripMap's points-circle, scaled down
              // for a thumbnail this small (as little as 44px, in the Recent Rides list).
              'circle-radius': 3.5,
              'circle-color': ['match', ['get', 'kind'], 'start', '#22a55a', 'end', '#e5484d', '#fff'],
              'circle-stroke-width': 1,
              'circle-stroke-color': '#fff',
            }}
          />
        </GeoJSONSource>
      </MapLibreMap>
    </View>
  );
}

function computeBounds(coordinates: number[][]): [number, number, number, number] {
  let minLon = coordinates[0][0];
  let maxLon = coordinates[0][0];
  let minLat = coordinates[0][1];
  let maxLat = coordinates[0][1];
  for (const [lon, lat] of coordinates) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const lonPad = Math.max((maxLon - minLon) * 0.15, 0.001);
  const latPad = Math.max((maxLat - minLat) * 0.15, 0.001);
  return [minLon - lonPad, minLat - latPad, maxLon + lonPad, maxLat + latPad];
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  empty: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#8882' },
  emptyText: { fontSize: 12, opacity: 0.5 },
});
