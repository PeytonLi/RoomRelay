package com.roomrelay.app.core.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameGateTest {

    @Test
    fun `single flight drops while busy`() {
        var now = 0L
        val gate = FrameGate(100L, clock = { now })
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
        assertEquals(GateResult.DROPPED_BUSY, gate.tryAcquire(now + 1_000L))
        gate.release()
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire(now + 1_000L))
    }

    @Test
    fun `min interval throttles`() {
        var now = 0L
        val gate = FrameGate(100L, clock = { now })
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
        gate.release()
        now = 50L
        assertEquals(GateResult.SKIPPED_THROTTLE, gate.tryAcquire())
        now = 100L
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
    }

    @Test
    fun `paused gate skips`() {
        val gate = FrameGate(100L)
        gate.paused = true
        assertEquals(GateResult.SKIPPED_PAUSED, gate.tryAcquire())
    }

    @Test
    fun `busy watchdog force-releases a wedged submission`() {
        var now = 0L
        val gate = FrameGate(100L, clock = { now }, busyTimeoutNs = 1_000L)
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
        // Still inside the timeout: dropped, not force-released.
        now = 500L
        assertEquals(GateResult.DROPPED_BUSY, gate.tryAcquire())
        assertEquals(0L, gate.timeoutCount)
        // Past the timeout: the frame is submitted and the timeout counted.
        now = 1_500L
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
        assertEquals(1L, gate.timeoutCount)
        // The new submission is busy; releasing it works normally.
        now = 1_600L
        assertEquals(GateResult.DROPPED_BUSY, gate.tryAcquire())
        gate.release()
        now = 1_700L
        assertEquals(GateResult.SUBMITTED, gate.tryAcquire())
        assertEquals(1L, gate.timeoutCount)
    }

    @Test
    fun `thermal policy intervals`() {
        assertEquals(200L, ThermalPolicy.minIntervalMs(ThermalStatus.NONE))
        assertEquals(200L, ThermalPolicy.minIntervalMs(ThermalStatus.LIGHT))
        assertEquals(333L, ThermalPolicy.minIntervalMs(ThermalStatus.MODERATE))
        assertEquals(1000L, ThermalPolicy.minIntervalMs(ThermalStatus.SEVERE))
        assertNull(ThermalPolicy.minIntervalMs(ThermalStatus.CRITICAL))
        assertNull(ThermalPolicy.minIntervalMs(ThermalStatus.EMERGENCY))
        assertNull(ThermalPolicy.minIntervalMs(ThermalStatus.SHUTDOWN))
        assertTrue(ThermalPolicy.isPaused(ThermalStatus.CRITICAL))
        assertFalse(ThermalPolicy.isPaused(ThermalStatus.MODERATE))
    }
}
