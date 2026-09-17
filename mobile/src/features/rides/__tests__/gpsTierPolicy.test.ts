import { decideGpsTierAction } from '@/features/rides/tripRecorder/gpsTierPolicy';

describe('gpsTierPolicy — decideGpsTierAction (Option 1 connection-gated idle strategy)', () => {
  describe('auto_start_blocked', () => {
    it('stops the watch and cancels the auto-start sustain window', () => {
      // Under the connection-gated model the watch is only ever running because the
      // board was connected — if a would-be start turns out blocked (board not usable),
      // stop the watch (the next board_connected transition restarts it) and cancel the
      // sustain window. There is no motion-gating dimension anymore.
      expect(decideGpsTierAction({ event: 'auto_start_blocked' })).toEqual({
        watch: { kind: 'stop' },
        cancelAutoStart: true,
      });
    });
  });

  describe('trip_starting', () => {
    it('forces the active tier, regardless of how the trip started', () => {
      expect(decideGpsTierAction({ event: 'trip_starting' })).toEqual({
        watch: { kind: 'set', tier: 'active' },
        cancelAutoStart: false,
      });
    });
  });

  describe('trip_ended', () => {
    it('keeps the idle-tier watch running when the board is still usable (manual end)', () => {
      // A trip ended but the board is still connected — keep the low-power idle-tier
      // watch running so the next ride auto-starts instantly.
      expect(decideGpsTierAction({ event: 'trip_ended', boardUsable: true })).toEqual({
        watch: { kind: 'start-if-idle', tier: 'idle' },
        cancelAutoStart: false,
      });
    });

    it('stops the watch entirely when the board is gone (BLE-disconnect auto-end)', () => {
      // The board is gone — no point paying GPS cost while there's no board to ride.
      expect(decideGpsTierAction({ event: 'trip_ended', boardUsable: false })).toEqual({
        watch: { kind: 'stop' },
        cancelAutoStart: false,
      });
    });
  });

  describe('board_connected', () => {
    it('starts the low-power idle-tier watch (no-op if already running)', () => {
      // The board connected while idle — start the idle-tier watch so location samples
      // flow and the board's wheel speed can drive an auto-start the moment the rider moves.
      expect(decideGpsTierAction({ event: 'board_connected' })).toEqual({
        watch: { kind: 'start-if-idle', tier: 'idle' },
        cancelAutoStart: false,
      });
    });
  });

  describe('board_disconnected', () => {
    it('stops the watch entirely', () => {
      // The board disconnected while idle — stop the watch; there's no board to ride.
      // (While recording, tripRecorder.ts guards this away so samples keep flowing to
      // the BLE-disconnect auto-end.)
      expect(decideGpsTierAction({ event: 'board_disconnected' })).toEqual({
        watch: { kind: 'stop' },
        cancelAutoStart: false,
      });
    });
  });

  describe('ensure_alive_while_recording', () => {
    it('forces an unconditional restart at the active tier — a dead JS watch subscription can leave currentWatchTier unchanged, so only a real restart (not a tier check) can self-heal it', () => {
      expect(decideGpsTierAction({ event: 'ensure_alive_while_recording' })).toEqual({
        watch: { kind: 'restart', tier: 'active' },
        cancelAutoStart: false,
      });
    });
  });
});
