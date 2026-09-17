import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { useThemeColor } from '@/components/Themed';
import { filterRouteSpikes, splitRouteGaps } from '@/features/rides/routeGeo';

type Point = { lat: number; lon: number };
type TimedPoint = Point & { timestampMs: number; speedKmh?: number };

/**
 * Small route-line preview — the RN equivalent of the prototype's per-trip canvas
 * thumbnail (trip-card's cvLast, mini-trip's thumb-cv). No basemap (that's what the
 * full MapLibre view on trip detail is for); this is just the shape of the ride,
 * uniformly scaled and centered so it isn't stretched.
 */
export function RouteThumbnail({
  route,
  snappedRoute,
  width,
  height,
  color,
  radius = 9,
}: {
  route: TimedPoint[] | undefined;
  snappedRoute?: Point[] | null;
  width: number;
  height: number;
  color: string;
  radius?: number;
}) {
  const surface2 = useThemeColor({}, 'surface2');
  // snappedRoute already comes off OSRM's own spike-filtered input; the raw-route
  // fallback still needs it applied here too (see lib/routeGeo.ts).
  const displayRoute = snappedRoute && snappedRoute.length >= 2 ? snappedRoute : route && filterRouteSpikes(route);

  const path = useMemo(() => {
    const route = displayRoute;
    if (!route || route.length < 2) return null;
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
    const latSpan = Math.max(maxLat - minLat, 1e-5);
    const lonSpan = Math.max(maxLon - minLon, 1e-5);
    const padX = width * 0.14;
    const padY = height * 0.14;
    const scale = Math.min((width - padX * 2) / lonSpan, (height - padY * 2) / latSpan);
    const usedW = lonSpan * scale;
    const usedH = latSpan * scale;
    const offX = (width - usedW) / 2;
    const offY = (height - usedH) / 2;

    const toXY = (p: Point) => {
      const x = offX + (p.lon - minLon) * scale;
      const y = height - offY - (p.lat - minLat) * scale;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    };

    // Same reasoning as TripMap/RouteMapThumbnail: only break on gaps for the
    // unsnapped route — snappedRoute is real street/path geometry with no
    // timestamps, so there's no fabricated straight line to guard against there.
    const isSnapped = !!(snappedRoute && snappedRoute.length >= 2);
    const segments = isSnapped ? [route as Point[]] : splitRouteGaps(route as TimedPoint[]);
    return segments.map((seg) => seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${toXY(p)}`).join(' ')).join(' ');
  }, [displayRoute, snappedRoute, width, height]);

  return (
    <View style={[styles.wrap, { width, height, borderRadius: radius, backgroundColor: surface2 }]}>
      {path && (
        <Svg width={width} height={height}>
          <Path d={path} stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
});
