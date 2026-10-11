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
