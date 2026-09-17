package expo.modules.ridecore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RideMachineTest {
  @Test
  fun `auto-start fires only after the sustain window, not on the first sample`() {
    val m = RideMachine()
    val t0 = 1_000_000L
    assertNull(m.onSample(30.0, t0))
    assertEquals(RideMachine.State.IDLE, m.getState())
    // Below the full sustain window — still idle.
    assertNull(m.onSample(30.0, t0 + 2_000))
    assertEquals(RideMachine.State.IDLE, m.getState())
    // Past the sustain window — fires exactly once, transitions to RIDING.
    val event = m.onSample(30.0, t0 + 3_500)
    assertTrue(event is RideMachine.Event.AutoStart)
    assertEquals(RideMachine.State.RIDING, m.getState())
  }

  @Test
  fun `a speed blip below threshold resets the sustain window`() {
    val m = RideMachine()
    val t0 = 0L
    m.onSample(30.0, t0)
    m.onSample(0.0, t0 + 500) // drops the EMA and clears the window
    // Even past the original 3s mark, no auto-start yet — the window restarted.
    val event = m.onSample(30.0, t0 + 3_200)
    assertNull(event)
    assertEquals(RideMachine.State.IDLE, m.getState())
  }

  @Test
  fun `disconnect ends a riding trip instantly, with no grace period`() {
    val m = RideMachine()
    val t0 = 0L
    m.onSample(30.0, t0)
    m.onSample(30.0, t0 + 3_500)
    assertEquals(RideMachine.State.RIDING, m.getState())

    val event = m.onDisconnect()
    assertTrue(event is RideMachine.Event.AutoEnd)
    assertEquals("board_off", (event as RideMachine.Event.AutoEnd).reason)
    assertEquals(RideMachine.State.IDLE, m.getState())
  }

  @Test
  fun `disconnect while idle is a no-op`() {
    val m = RideMachine()
    assertNull(m.onDisconnect())
    assertEquals(RideMachine.State.IDLE, m.getState())
  }

  @Test
  fun `a stationary board reports stopped but stays riding, never auto-ends on its own`() {
    val m = RideMachine()
    val t0 = 0L
    m.onSample(30.0, t0)
    m.onSample(30.0, t0 + 3_500)
    assertEquals(RideMachine.State.RIDING, m.getState())

    // Speed decays below STOP_SPEED_KMH via the EMA over several samples.
    var t = t0 + 3_500
    repeat(6) {
      t += 1_000
      m.onSample(0.0, t)
    }
    assertTrue(m.isStopped())
    // Stationary for a long time — still no auto-end without a disconnect.
    val event = m.onSample(0.0, t + 60_000)
    assertNull(event)
  }

  @Test
  fun `manual ride ignores speed entirely and only ends on disconnect or forceEnd`() {
    val m = RideMachine()
    val startEvent = m.beginManual()
    assertTrue(startEvent is RideMachine.Event.ManualStart)
    assertEquals(RideMachine.State.MANUAL, m.getState())

    // Standing still (speed 0) must not end a manual ride.
    assertNull(m.onSample(0.0, 10_000))
    assertEquals(RideMachine.State.MANUAL, m.getState())

    val disconnectEvent = m.onDisconnect()
    assertTrue(disconnectEvent is RideMachine.Event.AutoEnd)
    assertEquals(RideMachine.State.IDLE, m.getState())
  }

  @Test
  fun `forceEnd reports manual_end for a manual ride and auto_end(forced) otherwise`() {
    val manual = RideMachine()
    manual.beginManual()
    assertTrue(manual.forceEnd() is RideMachine.Event.ManualEnd)

    val auto = RideMachine()
    auto.onSample(30.0, 0)
    auto.onSample(30.0, 3_500)
    val event = auto.forceEnd()
    assertTrue(event is RideMachine.Event.AutoEnd)
    assertEquals("forced", (event as RideMachine.Event.AutoEnd).reason)
  }

  @Test
  fun `a fresh ride starts from a clean slate after the previous one ended while moving`() {
    // Real bug this guards against (ported from tripStateMachine.ts's own test suite):
    // ending a ride while still moving used to leave smoothedSpeedKmh high, so the next
    // ride's very first stationary sample decayed to a value that could still clear the
    // start threshold, or corrupt the sustain-window timing.
    val m = RideMachine()
    m.onSample(30.0, 0)
    m.onSample(30.0, 3_500)
    m.onDisconnect()
    assertEquals(RideMachine.State.IDLE, m.getState())

    // A single low-speed sample right after must not immediately auto-start.
    val event = m.onSample(0.0, 3_600)
    assertNull(event)
    assertEquals(RideMachine.State.IDLE, m.getState())
  }
}
