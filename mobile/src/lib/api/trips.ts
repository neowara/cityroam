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
  // Every call that lists or keeps ride data names its device: one device's data never
  // mixes with another's, and the backend refuses to guess when it can't.
  listTrips: (deviceId: string) => request<TripSummary[]>(`/trips?deviceId=${encodeURIComponent(deviceId)}`),
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
  listDeletedTrips: (deviceId: string) => request<DeletedTripSummary[]>(`/trips/deleted?deviceId=${encodeURIComponent(deviceId)}`),
  restoreDeletedTrips: (ids: number[]) =>
    request<{ restored: number }>('/trips/deleted/restore', { method: 'POST', body: JSON.stringify({ ids }) }),
  upsertInProgressTrip: (payload: InProgressTripPayload) =>
    request<{ ok: true }>('/trips/in-progress', { method: 'PUT', body: JSON.stringify(payload) }),
  getInProgressTrip: (deviceId: string) =>
    request<InProgressTripPayload | null>(`/trips/in-progress?deviceId=${encodeURIComponent(deviceId)}`),
  deleteInProgressTrip: (deviceId: string) =>
    request<void>(`/trips/in-progress?deviceId=${encodeURIComponent(deviceId)}`, { method: 'DELETE' }),
};
