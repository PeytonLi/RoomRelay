package com.roomrelay.app.core

import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.TreeMap

@Serializable
data class FrameObservation(
    val trackingState: String,
    val failureReason: String,
    val planesHorizontal: Int,
    val planesVertical: Int,
    val depthAttempted: Boolean,
    val depthAcquired: Boolean,
    val depthWidth: Int?,
    val depthHeight: Int?,
    val depthErrorClass: String?,
)

@Serializable
data class SessionSample(
    val second: Int,
    val frames: Int,
    val trackingState: String,
    val failureReason: String,
    val planesHorizontal: Int,
    val planesVertical: Int,
    val trackingFrames: Int,
    val depthAttempts: Int,
    val depthSuccesses: Int,
    val depthWidth: Int?,
    val depthHeight: Int?,
    val depthErrorClasses: List<String>,
)

@Serializable
data class SessionBreak(
    val pausedAtMs: Long,
    val resumedAtMs: Long?,
    val reason: String,
)

@Serializable
data class SessionLog(
    val startedAtUtc: String,
    val durationTargetS: Int,
    val endReason: String,
    val thermalStatusStart: String,
    val thermalStatusEnd: String,
    val depthMode: String,
    val samples: List<SessionSample>,
    val breaks: List<SessionBreak>,
)

class SessionLogger(
    private val durationS: Int = 60,
    private val utcNow: () -> String = { Instant.now().toString() },
) {
    private val samples = TreeMap<Int, MutableSample>()
    private val breaks = mutableListOf<SessionBreak>()
    private var startedAtUtc: String? = null
    private var startNs: Long? = null
    private var thermalStatusStart: String? = null
    private var thermalStatusEnd: String? = null
    private var depthMode: String? = null
    private var endReason: String? = null
    private var openBreakIndex: Int? = null

    @Volatile
    var isRunning: Boolean = false
        private set

    @Synchronized
    fun start(nowNs: Long, thermalStart: String, depthMode: String) {
        samples.clear()
        breaks.clear()
        startedAtUtc = utcNow()
        startNs = nowNs
        thermalStatusStart = thermalStart
        thermalStatusEnd = thermalStart
        this.depthMode = depthMode
        endReason = null
        openBreakIndex = null
        isRunning = true
    }

    @Synchronized
    fun onFrame(nowNs: Long, obs: FrameObservation) {
        if (!isRunning) return
        val second = elapsedNanos(nowNs).div(NANOS_PER_SECOND).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        val sample = samples.getOrPut(second) { MutableSample() }
        sample.frames += 1
        sample.trackingState = obs.trackingState
        sample.failureReason = obs.failureReason
        sample.planesHorizontal = obs.planesHorizontal
        sample.planesVertical = obs.planesVertical
        if (obs.trackingState == TRACKING) sample.trackingFrames += 1
        if (obs.depthAttempted) sample.depthAttempts += 1
        if (obs.depthAcquired) {
            sample.depthSuccesses += 1
            sample.depthWidth = obs.depthWidth
            sample.depthHeight = obs.depthHeight
        }
        obs.depthErrorClass
            ?.substringAfterLast('.')
            ?.takeUnless { it == NOT_YET_AVAILABLE }
            ?.let(sample.depthErrorClasses::add)
    }

    @Synchronized
    fun onPause(nowNs: Long) {
        if (!isRunning || openBreakIndex != null) return
        val pausedAtMs = elapsedNanos(nowNs) / NANOS_PER_MILLISECOND
        breaks += SessionBreak(pausedAtMs, null, ACTIVITY_PAUSED)
        openBreakIndex = breaks.lastIndex
    }

    @Synchronized
    fun onResume(nowNs: Long) {
        if (!isRunning) return
        val index = openBreakIndex ?: return
        breaks[index] = breaks[index].copy(
            resumedAtMs = elapsedNanos(nowNs) / NANOS_PER_MILLISECOND,
        )
        openBreakIndex = null
    }

    @Synchronized
    fun stop(nowNs: Long, thermalEnd: String, reason: String) {
        if (startNs == null) return
        isRunning = false
        thermalStatusEnd = thermalEnd
        endReason = reason
        if (openBreakIndex != null) {
            val index = openBreakIndex!!
            breaks[index] = breaks[index].copy(
                resumedAtMs = elapsedNanos(nowNs) / NANOS_PER_MILLISECOND,
            )
            openBreakIndex = null
        }
    }

    @Synchronized
    fun elapsedS(nowNs: Long): Long = elapsedNanos(nowNs) / NANOS_PER_SECOND

    @Synchronized
    fun shouldFinish(nowNs: Long): Boolean =
        isRunning && elapsedNanos(nowNs) >= durationS.toLong() * NANOS_PER_SECOND

    @Synchronized
    fun result(): SessionLog? {
        val reason = endReason ?: return null
        return SessionLog(
            startedAtUtc = startedAtUtc ?: return null,
            durationTargetS = durationS,
            endReason = reason,
            thermalStatusStart = thermalStatusStart ?: return null,
            thermalStatusEnd = thermalStatusEnd ?: return null,
            depthMode = depthMode ?: return null,
            samples = samples.map { (second, sample) -> sample.snapshot(second) },
            breaks = breaks.toList(),
        )
    }

    private fun elapsedNanos(nowNs: Long): Long =
        (nowNs - (startNs ?: nowNs)).coerceAtLeast(0L)

    private class MutableSample {
        var frames = 0
        var trackingState = ""
        var failureReason = ""
        var planesHorizontal = 0
        var planesVertical = 0
        var trackingFrames = 0
        var depthAttempts = 0
        var depthSuccesses = 0
        var depthWidth: Int? = null
        var depthHeight: Int? = null
        val depthErrorClasses = linkedSetOf<String>()

        fun snapshot(second: Int) = SessionSample(
            second = second,
            frames = frames,
            trackingState = trackingState,
            failureReason = failureReason,
            planesHorizontal = planesHorizontal,
            planesVertical = planesVertical,
            trackingFrames = trackingFrames,
            depthAttempts = depthAttempts,
            depthSuccesses = depthSuccesses,
            depthWidth = depthWidth,
            depthHeight = depthHeight,
            depthErrorClasses = depthErrorClasses.toList(),
        )
    }

    private companion object {
        const val TRACKING = "TRACKING"
        const val NOT_YET_AVAILABLE = "NotYetAvailableException"
        const val ACTIVITY_PAUSED = "ACTIVITY_PAUSED"
        const val NANOS_PER_SECOND = 1_000_000_000L
        const val NANOS_PER_MILLISECOND = 1_000_000L
    }
}
