import { shouldDiscardTrip, TripStateMachine } from '@/features/rides/tripStateMachine';

describe('TripStateMachine', () => {
  it('starts idle', () => {
    expect(new TripStateMachine().getState()).toBe('idle');
  });

  it('stays idle below the start threshold even if sustained', () => {
    const m = new TripStateMachine();
    let t = 0;
    for (let i = 0; i < 20; i++) {
      m.onSample(5, t); // below the 15 km/h start threshold
      t += 1000;
    }
    expect(m.getState()).toBe('idle');
  });

  it('auto-starts once speed clears the threshold for the sustain window', () => {
    const m = new TripStateMachine();
    let t = 0;
    let event = null;
    // EMA needs several samples above threshold before the smoothed value itself clears 15 km/h
    for (let i = 0; i < 30; i++) {
      event = m.onSample(20, t) ?? event;
      t += 1000;
    }
    expect(event).toEqual({ type: 'auto_start' });
    expect(m.getState()).toBe('riding');
  });

  // Hard requirement: no grace period on a board disconnect — the very
  // first offline sample ends the trip immediately, even while GPS still reads moving.
  it('auto-ends the instant the device goes offline, even while still riding', () => {
    const m = new TripStateMachine();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      m.onSample(20, t);
      t += 1000;
    }
    expect(m.getState()).toBe('riding');

    const event = m.onSample(20, t, true);
    expect(event).toEqual({ type: 'auto_end', reason: 'ble_disconnect', offlineForMs: 0 });
    expect(m.getState()).toBe('idle');
  });

  it('a brief stop (red light) does not end the trip', () => {
    const m = new TripStateMachine();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      m.onSample(20, t);
      t += 1000;
    }
    expect(m.getState()).toBe('riding');

    for (let i = 0; i < 30; i++) {
      m.onSample(0, t); // stopped for 30s
      t += 1000;
    }
    expect(m.getState()).toBe('stopped');

    let resumed = false;
    for (let i = 0; i < 20; i++) {
      m.onSample(20, t);
      t += 1000;
      if (m.getState() === 'riding') {
        resumed = true;
        break;
      }
    }
    expect(resumed).toBe(true);
  });

  // there is no speed-based stop timeout — a stationary
  // board (still BLE-connected) reports `stopped` but never ends the trip on its own.
  // Only a BLE disconnect ends an auto-detected ride.
  it('does NOT end a stopped trip while the device stays online, however long it idles', () => {
    const m = new TripStateMachine();
    let timestamp = 0;
    for (let index = 0; index < 30; index += 1) {
      m.onSample(20, timestamp);
      timestamp += 1000;
    }
    expect(m.getState()).toBe('riding');

    // Idle for far longer than the old 150s stop timeout — still recording.
    for (let index = 0; index < 300; index += 1) {
      expect(m.onSample(0, timestamp, false)).toBeNull();
      timestamp += 1000;
    }
    expect(m.getState()).toBe('stopped');

    // A BLE disconnect is the sole auto-stop signal.
    const event = m.onSample(0, timestamp, true);
    expect(event).toEqual({ type: 'auto_end', reason: 'ble_disconnect', offlineForMs: 0 });
    expect(m.getState()).toBe('idle');
  });

  it('manual mode suspends speed-based auto-start/stop detection', () => {
    const m = new TripStateMachine();
    m.beginManual();
    expect(m.getState()).toBe('manual');
    const event = m.onSample(0, 0); // would normally be irrelevant either way
    expect(event).toBeNull();
    expect(m.getState()).toBe('manual');
  });

  it('auto-ends a manual trip the instant the board disconnects — real user report: a manual trip kept recording after the board died', () => {
    const m = new TripStateMachine();
    m.beginManual();
    const event = m.onSample(0, 0, true);
    expect(event).toEqual({ type: 'auto_end', reason: 'ble_disconnect', offlineForMs: 0 });
    expect(m.getState()).toBe('idle');
  });

  it('does not auto-end a manual trip while the device stays online, however long it idles', () => {
    const m = new TripStateMachine();
    m.beginManual();
    let t = 0;
    for (let i = 0; i < 200; i++) {
      expect(m.onSample(0, t, false)).toBeNull();
      t += 1000;
    }
    expect(m.getState()).toBe('manual');
  });

  // auto-start is driven purely by the board's wheel
  // speed — there is no motion-activity gate. A false Activity-Recognition "stationary"
  // verdict (the phone is mounted, AR has no "scooter" category) must never hold a real
  // start back. A speed drop mid-sustain-window still resets the debounce.
  it('auto-starts on board speed alone, with no motion-activity gate', () => {
    const m = new TripStateMachine();
    let t = 0;
    let event = null;
    for (let i = 0; i < 30; i++) {
      event = m.onSample(20, t) ?? event;
      t += 1000;
    }
    expect(event).toEqual({ type: 'auto_start' });
    expect(m.getState()).toBe('riding');
  });

  it('resets the sustain window if speed drops below the start threshold mid-window', () => {
    const m = new TripStateMachine();
    let t = 0;
    // 2s above threshold (not yet enough to clear the 3s sustain window)...
    m.onSample(20, t);
    t += 1000;
    m.onSample(20, t);
    t += 1000;
    // ...then a speed drop for a beat...
    const dropEvent = m.onSample(0, t);
    t += 1000;
    expect(dropEvent).toBeNull();
    expect(m.getState()).toBe('idle');
    // ...then speed returns — must restart the 3s sustain window, not resume the old one.
    let event = null;
    for (let i = 0; i < 2; i++) {
      event = m.onSample(20, t) ?? event;
      t += 1000;
    }
    expect(event).toBeNull(); // only ~2s of the fresh window elapsed, not yet 3s
    expect(m.getState()).toBe('idle');
  });

  it('forceEnd reports manual_end from manual mode and auto_end from riding', () => {
    const manual = new TripStateMachine();
    manual.beginManual();
    expect(manual.forceEnd()).toEqual({ type: 'manual_end' });

    const auto = new TripStateMachine();
    let t = 0;
    for (let i = 0; i < 30; i++) {
      auto.onSample(20, t);
      t += 1000;
    }
    expect(auto.getState()).toBe('riding');
    expect(auto.forceEnd()).toEqual({ type: 'auto_end', reason: 'forced' });
  });
});

describe('shouldDiscardTrip', () => {
  it('discards an accidental double-tap (short distance and short duration)', () => {
    expect(shouldDiscardTrip(0.01, 5)).toBe(true);
  });

  it('keeps a genuine short ride that clears both floors', () => {
    expect(shouldDiscardTrip(0.3, 15)).toBe(false);
  });

  // the old AND-based guard let a trip with genuinely zero
  // distance through as long as it ran long enough — several 0.0km, multi-minute
  // trips were confirmed saved to production this way (GPS never got a fix, or the
  // rider forgot to stop a stationary recording). Distance is now an unconditional
  // floor, independent of how long the trip ran.
  it('discards a long-duration trip that never actually moved', () => {
    expect(shouldDiscardTrip(0.02, 300)).toBe(true);
  });

  it('discards a trip that has real distance but ended almost immediately', () => {
    expect(shouldDiscardTrip(0.5, 3)).toBe(true);
  });
});
