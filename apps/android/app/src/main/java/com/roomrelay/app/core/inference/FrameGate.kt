package com.roomrelay.app.core.inference

enum class GateResult {
    SUBMITTED,
    DROPPED_BUSY,
    SKIPPED_THROTTLE,
    SKIPPED_PAUSED,
}

/**
 * Single-flight, min-interval gate in front of the detector. One inference at
 * a time; frames arriving while busy or inside the interval are dropped and
 * counted rather than queued.
 */
class FrameGate(
    private val minIntervalNs: Long,
    private val clock: () -> Long = { System.nanoTime() },
) {
    @Volatile
    private var busy = false

    private var lastSubmitNs = Long.MIN_VALUE / 2

    @Volatile
    var paused: Boolean = false

    /** Thermal override for the min interval; null uses [minIntervalNs]. */
    @Volatile
    var minIntervalOverrideNs: Long? = null

    private fun effectiveMinIntervalNs(): Long = minIntervalOverrideNs ?: minIntervalNs

    fun tryAcquire(nowNs: Long = clock()): GateResult {
        if (paused) return GateResult.SKIPPED_PAUSED
        if (busy) return GateResult.DROPPED_BUSY
        if (nowNs - lastSubmitNs < effectiveMinIntervalNs()) return GateResult.SKIPPED_THROTTLE
        busy = true
        lastSubmitNs = nowNs
        return GateResult.SUBMITTED
    }

    /** Called when a submitted inference finishes (result or error). */
    fun release() {
        busy = false
    }

    fun isBusy(): Boolean = busy
}

enum class ThermalStatus {
    NONE,
    LIGHT,
    MODERATE,
    SEVERE,
    CRITICAL,
    EMERGENCY,
    SHUTDOWN,
    UNKNOWN,
}

object ThermalPolicy {
    const val NORMAL_INTERVAL_MS = 200L
    const val MODERATE_INTERVAL_MS = 333L
    const val SEVERE_INTERVAL_MS = 1000L

    /**
     * Minimum inference interval for a thermal status, or null when inference
     * must pause entirely.
     */
    fun minIntervalMs(status: ThermalStatus): Long? = when (status) {
        ThermalStatus.NONE, ThermalStatus.LIGHT, ThermalStatus.UNKNOWN ->
            NORMAL_INTERVAL_MS
        ThermalStatus.MODERATE -> MODERATE_INTERVAL_MS
        ThermalStatus.SEVERE -> SEVERE_INTERVAL_MS
        ThermalStatus.CRITICAL, ThermalStatus.EMERGENCY, ThermalStatus.SHUTDOWN -> null
    }

    fun isPaused(status: ThermalStatus): Boolean = minIntervalMs(status) == null
}
