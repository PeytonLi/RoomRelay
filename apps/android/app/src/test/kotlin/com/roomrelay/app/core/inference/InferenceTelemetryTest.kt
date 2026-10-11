package com.roomrelay.app.core.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class InferenceTelemetryTest {

    @Test
    fun `percentile empty returns null`() {
        assertNull(InferenceTelemetry.percentile(emptyList(), 0.5))
        assertNull(InferenceTelemetry.percentile(emptyList(), 0.95))
    }

    @Test
    fun `percentile single element`() {
        assertEquals(7L, InferenceTelemetry.percentile(listOf(7L), 0.5))
        assertEquals(7L, InferenceTelemetry.percentile(listOf(7L), 0.95))
    }

    @Test
    fun `nearest rank percentile`() {
        val sorted = (1L..100L).toList()
        assertEquals(50L, InferenceTelemetry.percentile(sorted, 0.50))
        assertEquals(95L, InferenceTelemetry.percentile(sorted, 0.95))
        assertEquals(1L, InferenceTelemetry.percentile(sorted, 0.01))
        assertEquals(100L, InferenceTelemetry.percentile(sorted, 1.0))
    }

    @Test
    fun `counters and fps`() {
        var now = 0L
        val telemetry = InferenceTelemetry(clockNs = { now })
        telemetry.recordGate(GateResult.SUBMITTED)
        telemetry.recordGate(GateResult.DROPPED_BUSY)
        telemetry.recordGate(GateResult.SKIPPED_THROTTLE)
        telemetry.recordCameraImageNotYetAvailable()
        telemetry.recordCameraImageError("ResourceExhaustedException")
        now = 1_000_000_000L
        telemetry.recordResult(50_000_000L, now)
        telemetry.recordDetections(listOf("chair", "chair", "cup"))
        telemetry.recordCandidates(listOf(RoomRelayCategory.CHAIR))
        val snap = telemetry.snapshot()
        assertEquals(1L, snap.submitted)
        assertEquals(1L, snap.completed)
        assertEquals(1L, snap.droppedBusy)
        assertEquals(1L, snap.skippedThrottle)
        assertEquals(1L, snap.cameraImageNotYetAvailable)
        assertEquals(1L, snap.cameraImageErrors["ResourceExhaustedException"])
        assertEquals(50.0, snap.latencyP50Ms!!, 0.01)
        assertEquals(1.0, snap.achievedFps, 0.01)
        assertEquals(2L, snap.detectionsPerCocoLabel["chair"])
        assertEquals(1L, snap.detectionsPerCocoLabel["cup"])
        assertEquals(1L, snap.candidatesPerCategory["CHAIR"])
    }

    @Test
    fun `thermal transitions tracked`() {
        var now = 0L
        val telemetry = InferenceTelemetry(clockNs = { now })
        telemetry.onThermalStatus("NONE", now)
        now = 5_000_000_000L
        telemetry.onThermalStatus("SEVERE", now)
        now = 8_000_000_000L
        telemetry.onThermalStatus("CRITICAL", now)
        val snap = telemetry.snapshot()
        assertEquals("NONE", snap.thermalStart)
        assertEquals("CRITICAL", snap.thermalEnd)
        assertEquals("CRITICAL", snap.thermalMax)
        assertEquals(2, snap.thermalTransitions.size)
        assertEquals(5000L, snap.thermalTransitions[0].elapsedMs)
        assertEquals("SEVERE", snap.thermalTransitions[0].status)
    }
}
