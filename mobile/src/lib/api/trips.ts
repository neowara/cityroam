import type { TripCreate } from '@/features/rides/tripTypes';
import type { TripSummary, TripDetail, DeletedTripSummary, InProgressTripPayload } from '@/lib/types';

import { request } from '@/lib/api/client';
import type { RoutePointElevation } from '@/lib/api/rangeEstimate';

// Compares battery cost by mode for the SAME real route just ridden, not a
// whole-history average — a completed trip's distance is fixed, so the meaningful
// per-mode figure is battery %-cost, not a range in km.
export type TripByMode = {
  actualMode: string | null;
  actualBatteryUsedPct: number | null;
  modes: Record<
    string,
    {
      estimatedBatteryUsedPct: number | null;
      estimatedEnergyWh: number | null;
      avgSpeedKmh: number | null;
      sampleTripCount: number;
    }
  >;
};

export const tripsApi = {
  // deviceId is purely additive: omitted means "every board combined", same as
  // before this filter existed.
  listTrips: (deviceId?: string | null) => request<TripSummary[]>(`/trips${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
  createTrip: (trip: TripCreate) => request<TripDetail>('/trips', { method: 'POST', body: JSON.stringify(trip) }),
  getTrip: (id: number) => request<TripDetail>(`/trips/${id}`),
  // Fetched lazily, not stored on the trip (see the backend's trips_service.get_trip_elevation
  // docstring) — a completed trip's route never carried elevation at save time.
  getTripElevation: (id: number) => request<RoutePointElevation[]>(`/trips/${id}/elevation`),
  // Same lazy-fetch/re-simulate-on-demand shape as getTripElevation above.
  getTripByMode: (id: number) => request<TripByMode>(`/trips/${id}/by-mode`),
  deleteTrip: (id: number) => request<void>(`/trips/${id}`, { method: 'DELETE' }),
  updateTripVitals: (
    id: number,
    vitals: Partial<{
      heartRateAvgBpm: number;
      heartRateMaxBpm: number;
      heartRateStartBpm: number;
      heartRateEndBpm: number;
      restingHeartRateBpm: number;
      heartRateVariabilityMs: number;
      steps: number;
    }>,
  ) => request<TripDetail>(`/trips/${id}/vitals`, { method: 'PATCH', body: JSON.stringify(vitals) }),
  listDeletedTrips: () => request<DeletedTripSummary[]>('/trips/deleted'),
  restoreDeletedTrips: (ids: number[]) =>
    request<{ restored: number }>('/trips/deleted/restore', { method: 'POST', body: JSON.stringify({ ids }) }),
  upsertInProgressTrip: (payload: InProgressTripPayload) =>
    request<{ ok: true }>('/trips/in-progress', { method: 'PUT', body: JSON.stringify(payload) }),
  getInProgressTrip: () => request<InProgressTripPayload | null>('/trips/in-progress'),
  deleteInProgressTrip: () => request<void>('/trips/in-progress', { method: 'DELETE' }),
};
