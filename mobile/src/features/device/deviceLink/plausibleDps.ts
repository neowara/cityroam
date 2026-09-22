// The board's first status burst after a handshake carries placeholder zeros for the
// odometer (dp12) and pack voltage (dp20) before the real values arrive a few seconds
// later. Neither can genuinely read 0 on a board that is talking to us, so those
// readings are dropped before they reach the cache. A lower odometer than last time is
// kept: the controller can fall back to an older stored total after losing power, and
// what it reports is still the truth.
const ODOMETER_DP = '12';
const VOLTAGE_DP = '20';

/** Returns `incoming` without the placeholder zero odometer or voltage values. */
export function dropImplausibleDps(incoming: Record<string, unknown>): Record<string, unknown> {
  const out = { ...incoming };
  for (const dp of [ODOMETER_DP, VOLTAGE_DP]) {
    const value = out[dp];
    if (typeof value === 'number' && value <= 0) delete out[dp];
  }
  return out;
}
