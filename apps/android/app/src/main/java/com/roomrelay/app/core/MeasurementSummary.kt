package com.roomrelay.app.core

import kotlin.math.abs
import kotlinx.serialization.Serializable

@Serializable
enum class TrialSurface {
    FLOOR,
    TABLE_EDGE,
    OTHER,
}

@Serializable
enum class TrialDistance {
    NEAR_1M,
    FAR_3M,
    OTHER,
}

@Serializable
data class ConditionSummary(
    val surface: TrialSurface,
    val nominalDistance: TrialDistance,
    val count: Int,
    val meanErrorCm: Double,
    val meanAbsErrorCm: Double,
    val maxAbsErrorCm: Double,
    val meanAbsErrorPct: Double,
)

const val TRIALS_PER_CONDITION = 3

val PROTOCOL_CONDITIONS: List<Pair<TrialSurface, TrialDistance>> =
    listOf(
        TrialSurface.FLOOR to TrialDistance.NEAR_1M,
        TrialSurface.FLOOR to TrialDistance.FAR_3M,
        TrialSurface.TABLE_EDGE to TrialDistance.NEAR_1M,
        TrialSurface.TABLE_EDGE to TrialDistance.FAR_3M,
    )

fun summarizeTrials(trials: List<MeasurementTrial>): List<ConditionSummary> =
    trials.groupBy { it.surface to it.nominalDistance }
        .map { (condition, groupedTrials) ->
            ConditionSummary(
                surface = condition.first,
                nominalDistance = condition.second,
                count = groupedTrials.size,
                meanErrorCm = groupedTrials.map { it.errorCm }.average(),
                meanAbsErrorCm = groupedTrials.map { abs(it.errorCm) }.average(),
                maxAbsErrorCm = groupedTrials.maxOf { abs(it.errorCm) },
                meanAbsErrorPct = groupedTrials.map { abs(it.errorPct) }.average(),
            )
        }
        .sortedWith(
            compareBy<ConditionSummary> { it.surface.ordinal }
                .thenBy { it.nominalDistance.ordinal },
        )

fun TrialSurface.displayName(): String = when (this) {
    TrialSurface.FLOOR -> "Floor"
    TrialSurface.TABLE_EDGE -> "Table edge"
    TrialSurface.OTHER -> "Other"
}

fun TrialDistance.displayName(): String = when (this) {
    TrialDistance.NEAR_1M -> "~1 m"
    TrialDistance.FAR_3M -> "~3 m"
    TrialDistance.OTHER -> "Other"
}
