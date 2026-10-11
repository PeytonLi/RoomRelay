package com.roomrelay.app.core.inference

import kotlinx.serialization.Serializable

@Serializable
data class InferenceTelemetrySnapshot(
    val submitted: Long = 0,
    val completed: Long = 0,
    val droppedBusy: Long = 0,
    val skippedThrottle: Long = 0,
    val skippedPaused: Long = 0,
    val cameraImageNotYetAvailable: Long = 0,
    val cameraImageErrors: Map<String, Long> = emptyMap(),
    val inferenceErrors: Long = 0,
    val latencyP50Ms: Double? = null,
    val latencyP95Ms: Double? = null,
    val preprocessAvgMs: Double? = null,
    val achievedFps: Double = 0.0,
    val thermalStart: String? = null,
    val thermalEnd: String? = null,
    val thermalMax: String? = null,
    val thermalTransitions: List<ThermalTransition> = emptyList(),
    val detectionsPerCocoLabel: Map<String, Long> = emptyMap(),
    val candidatesPerCategory: Map<String, Long> = emptyMap(),
)

@Serializable
data class ThermalTransition(
    val elapsedMs: Long,
    val status: String,
)

private val THERMAL_SEVERITY = mapOf(
    "NONE" to 0,
    "LIGHT" to 1,
    "MODERATE" to 2,
    "SEVERE" to 3,
    "CRITICAL" to 4,
    "EMERGENCY" to 5,
    "SHUTDOWN" to 6,
    "UNKNOWN" to -1,
)

private const val WINDOW = 1000

/**
 * Thread-safe-ish counters for the detection pipeline. Latency = submit
 * (detectAsync) to result listener. Preprocess = camera-image copy + YUV
 * conversion time.
 */
class InferenceTelemetry(
    private val clockNs: () -> Long = { System.nanoTime() },
) {
    private val lock = Any()
    private var submitted = 0L
    private var completed = 0L
    private var droppedBusy = 0L
    private var skippedThrottle = 0L
    private var skippedPaused = 0L
    private var notYetAvailable = 0L
    private var inferenceErrors = 0L
    private val cameraImageErrors = LinkedHashMap<String, Long>()
    private val latenciesNs = ArrayDeque<Long>()
    private var preprocessTotalMs = 0.0
    private var preprocessCount = 0L
    private var firstSubmitNs: Long? = null
    private var lastCompleteNs: Long? = null
    private var thermalStart: String? = null
    private var thermalEnd: String? = null
    private var thermalMax: String? = null
    private val thermalTransitions = mutableListOf<ThermalTransition>()
    private var thermalStartNs: Long? = null
    private val detectionsPerLabel = LinkedHashMap<String, Long>()
    private val candidatesPerCategory = LinkedHashMap<String, Long>()

    fun recordGate(result: GateResult) {
        synchronized(lock) {
            when (result) {
                GateResult.SUBMITTED -> {
                    submitted += 1
                    if (firstSubmitNs == null) firstSubmitNs = clockNs()
                }
                GateResult.DROPPED_BUSY -> droppedBusy += 1
                GateResult.SKIPPED_THROTTLE -> skippedThrottle += 1
                GateResult.SKIPPED_PAUSED -> skippedPaused += 1
            }
        }
    }

    fun recordCameraImageNotYetAvailable() {
        synchronized(lock) { notYetAvailable += 1 }
    }

    fun recordCameraImageError(exceptionClass: String) {
        synchronized(lock) {
            cameraImageErrors.merge(exceptionClass, 1L, Long::plus)
        }
    }

    fun recordPreprocess(elapsedMs: Double) {
        synchronized(lock) {
            preprocessTotalMs += elapsedMs
            preprocessCount += 1
        }
    }

    fun recordInferenceError() {
        synchronized(lock) { inferenceErrors += 1 }
    }

    fun recordResult(latencyNs: Long, nowNs: Long = clockNs()) {
        synchronized(lock) {
            completed += 1
            lastCompleteNs = nowNs
            latenciesNs.addLast(latencyNs)
            while (latenciesNs.size > WINDOW) latenciesNs.removeFirst()
        }
    }

    fun recordDetections(cocoLabels: List<String>) {
        synchronized(lock) {
            cocoLabels.forEach { detectionsPerLabel.merge(it, 1L, Long::plus) }
        }
    }

    fun recordCandidates(categories: List<RoomRelayCategory>) {
        synchronized(lock) {
            categories.forEach { candidatesPerCategory.merge(it.name, 1L, Long::plus) }
        }
    }

    fun onThermalStatus(status: String, nowNs: Long = clockNs()) {
        synchronized(lock) {
            if (thermalStart == null) {
                thermalStart = status
                thermalStartNs = nowNs
                thermalEnd = status
                thermalMax = status
            }
            if (thermalEnd != status) {
                val elapsed = nowNs - (thermalStartNs ?: nowNs)
                thermalTransitions.add(ThermalTransition(elapsed / 1_000_000L, status))
                thermalEnd = status
                val severity = THERMAL_SEVERITY[status] ?: -1
                val maxSeverity = THERMAL_SEVERITY[thermalMax] ?: -1
                if (severity > maxSeverity) thermalMax = status
            }
        }
    }

    fun snapshot(): InferenceTelemetrySnapshot = synchronized(lock) {
        val latencies = latenciesNs.sorted()
        val activeNs = if (firstSubmitNs != null && lastCompleteNs != null) {
            (lastCompleteNs!! - firstSubmitNs!!).coerceAtLeast(1L)
        } else {
            0L
        }
        InferenceTelemetrySnapshot(
            submitted = submitted,
            completed = completed,
            droppedBusy = droppedBusy,
            skippedThrottle = skippedThrottle,
            skippedPaused = skippedPaused,
            cameraImageNotYetAvailable = notYetAvailable,
            cameraImageErrors = cameraImageErrors.toMap(),
            inferenceErrors = inferenceErrors,
            latencyP50Ms = percentile(latencies, 0.50)?.let { it / 1_000_000.0 },
            latencyP95Ms = percentile(latencies, 0.95)?.let { it / 1_000_000.0 },
            preprocessAvgMs =
                if (preprocessCount > 0) preprocessTotalMs / preprocessCount else null,
            achievedFps = if (activeNs > 0) completed * 1_000_000_000.0 / activeNs else 0.0,
            thermalStart = thermalStart,
            thermalEnd = thermalEnd,
            thermalMax = thermalMax,
            thermalTransitions = thermalTransitions.toList(),
            detectionsPerCocoLabel = detectionsPerLabel.toMap(),
            candidatesPerCategory = candidatesPerCategory.toMap(),
        )
    }

    companion object {
        /** Nearest-rank percentile: k = ceil(q * n). Empty input -> null. */
        fun percentile(sorted: List<Long>, q: Double): Long? {
            if (sorted.isEmpty()) return null
            val k = Math.ceil(q * sorted.size).toInt().coerceIn(1, sorted.size)
            return sorted[k - 1]
        }
    }
}
