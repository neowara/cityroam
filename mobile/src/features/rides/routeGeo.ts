// Re-export shim — the shared route-geometry primitives moved to mobile/lib/routeGeometry.ts
// (so geo.ts and routeGeo.ts share one source of truth, e.g. MAX_PLAUSIBLE_KMH). Kept so
// existing importers (TripMap, RouteMapThumbnail, RouteThumbnail) work unchanged.
export { filterRouteSpikes, splitRouteGaps } from '@/features/rides/routeGeometry';
