/** The board's own odometer, and whether it was read live or is the last value the
 * board sent before it went out of range. */
export type OdometerReading = { km: number; source: 'live' | 'last-reported' };

/** The board is the only source of truth for its odometer, so this never estimates one
 * from trip history: a live dp12 reading wins, then the last one the board reported,
 * otherwise there is nothing to show. */
export function pickOdometerReading(liveKm: number | null | undefined, lastReportedKm: number | null | undefined): OdometerReading | null {
  if (liveKm != null) return { km: liveKm, source: 'live' };
  if (lastReportedKm != null) return { km: lastReportedKm, source: 'last-reported' };
  return null;
}
