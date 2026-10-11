package com.roomrelay.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionLoggerTest {
    @Test
    fun countsFramesDepthAndRetainsLastFrameState() {
        val logger = logger()
        logger.start(0L, "NONE", "AUTOMATIC")
        repeat(30) { index ->
            logger.onFrame(
                index * 10_000_000L,
                observation(
                    trackingState = if (index == 29) "PAUSED" else "TRACKING",
                    failureReason = if (index == 29) "INSUFFICIENT_LIGHT" else "",
                    depthAttempted = index < 3,
                    depthAcquired = index < 2,
                    depthWidth = if (index == 1) 320 else null,
                    depthHeight = if (index == 1) 240 else null,
                    depthErrorClass = if (index == 2) "NotYetAvailableException" else null,
                    planesHorizontal = if (index == 29) 4 else 2,
                    planesVertical = if (index == 29) 3 else 1,
                ),
            )
        }

        val sample = logger.resultAfterStop().samples.single()
        assertEquals(30, sample.frames)
        assertEquals(29, sample.trackingFrames)
        assertEquals(3, sample.depthAttempts)
        assertEquals(2, sample.depthSuccesses)
        assertEquals(320, sample.depthWidth)
        assertEquals(240, sample.depthHeight)
        assertEquals(4, sample.planesHorizontal)
        assertEquals(3, sample.planesVertical)
        assertEquals("PAUSED", sample.trackingState)
        assertEquals("INSUFFICIENT_LIGHT", sample.failureReason)
        assertTrue(sample.depthErrorClasses.isEmpty())
    }

    @Test
    fun pauseRecordsBreakAndLeavesSecondsWithoutFramesEmpty() {
        val logger = logger()
        logger.start(0L, "NONE", "AUTOMATIC")
        logger.onFrame(0L, observation())
        logger.onPause(10_500_000_000L)
        logger.onResume(20_200_000_000L)
        logger.onFrame(20_300_000_000L, observation())
        logger.stop(20_400_000_000L, "LIGHT", "STOPPED_BY_USER")

        val result = logger.result()!!
        assertEquals(SessionBreak(10_500L, 20_200L, "ACTIVITY_PAUSED"), result.breaks.single())
        assertEquals(listOf(0, 20), result.samples.map { it.second })
        assertFalse((11..19).any { second -> result.samples.any { it.second == second } })
    }

    @Test
    fun durationAndEndReasonsAreRecorded() {
        val logger = logger()
        logger.start(0L, "NONE", "AUTOMATIC")
        assertFalse(logger.shouldFinish(59_999_999_999L))
        assertTrue(logger.shouldFinish(60_000_000_000L))
        assertEquals(60L, logger.elapsedS(60_000_000_000L))
        logger.stop(60_000_000_000L, "MODERATE", "COMPLETED")
        assertEquals("COMPLETED", logger.result()!!.endReason)

        logger.start(0L, "NONE", "DISABLED")
        logger.stop(1_000_000_000L, "NONE", "COMPLETED_AFTER_PAUSE")
        assertEquals("COMPLETED_AFTER_PAUSE", logger.result()!!.endReason)
        logger.start(0L, "NONE", "DISABLED")
        logger.stop(1_000_000_000L, "NONE", "STOPPED_BY_USER")
        assertEquals("STOPPED_BY_USER", logger.result()!!.endReason)
    }

    @Test
    fun distinctDepthErrorsExcludeNotYetAvailable() {
        val logger = logger()
        logger.start(0L, "NONE", "AUTOMATIC")
        listOf("NotYetAvailableException", "SecurityException", "SecurityException").forEachIndexed { index, error ->
            logger.onFrame(
                index * 1_000_000L,
                observation(depthAttempted = true, depthErrorClass = error),
            )
        }
        logger.stop(3_000_000L, "NONE", "STOPPED_BY_USER")
        assertEquals(listOf("SecurityException"), logger.result()!!.samples.single().depthErrorClasses)
    }

    private fun logger() = SessionLogger(utcNow = { "2026-10-11T00:00:00Z" })

    private fun SessionLogger.resultAfterStop(): SessionLog {
        stop(1_000_000_000L, "NONE", "STOPPED_BY_USER")
        return result()!!
    }

    private fun observation(
        trackingState: String = "TRACKING",
        failureReason: String = "",
        depthAttempted: Boolean = false,
        depthAcquired: Boolean = false,
        depthWidth: Int? = null,
        depthHeight: Int? = null,
        depthErrorClass: String? = null,
        planesHorizontal: Int = 2,
        planesVertical: Int = 1,
    ) = FrameObservation(
        trackingState = trackingState,
        failureReason = failureReason,
        planesHorizontal = planesHorizontal,
        planesVertical = planesVertical,
        depthAttempted = depthAttempted,
        depthAcquired = depthAcquired,
        depthWidth = depthWidth,
        depthHeight = depthHeight,
        depthErrorClass = depthErrorClass,
    )
}
