// The board's first status burst after a handshake can carry placeholder zeros for the
// odometer (dp12) and pack voltage (dp20) before the real values arrive a few seconds
// later. Neither can genuinely read 0 on a board that is talking to us, and the
// odometer never counts down, so those readings are dropped before they reach the cache.
const ODOMETER_DP = '12';
const VOLTAGE_DP = '20';

/** Returns `incoming` without any odometer or voltage value that can't be real, judged
 * against the values already cached for this board. */
export function dropImplausibleDps(
  cached: Record<string, unknown> | null,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...incoming };
  const odometer = out[ODOMETER_DP];
  if (typeof odometer === 'number') {
    const previous = cached?.[ODOMETER_DP];
    if (odometer <= 0 || (typeof previous === 'number' && odometer < previous)) delete out[ODOMETER_DP];
  }
  const voltage = out[VOLTAGE_DP];
  if (typeof voltage === 'number' && voltage <= 0) delete out[VOLTAGE_DP];
  return out;
}
