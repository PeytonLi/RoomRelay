package com.roomrelay.app.core

import org.junit.Assert.assertEquals
import org.junit.Test

class MeasurementSummaryTest {
    @Test
    fun emptyTrialsHaveNoSummaries() {
        assertEquals(emptyList<ConditionSummary>(), summarizeTrials(emptyList()))
    }

    @Test
    fun summarizesSignedAndAbsoluteErrorsWithoutRounding() {
        val summary = summarizeTrials(
            listOf(
                trial(2.0, 2.0),
                trial(-4.0, -4.0),
                trial(1.0, 1.0),
            ),
        ).single()

        assertEquals(-1.0 / 3.0, summary.meanErrorCm, 1e-9)
        assertEquals(7.0 / 3.0, summary.meanAbsErrorCm, 1e-9)
        assertEquals(4.0, summary.maxAbsErrorCm, 1e-9)
        assertEquals(7.0 / 3.0, summary.meanAbsErrorPct, 1e-9)
        assertEquals(3, summary.count)
    }

    @Test
    fun groupsOnlyPresentConditionsInSurfaceThenDistanceOrderIncludingOther() {
        val trials = listOf(
            trial(1.0, 1.0, TrialSurface.OTHER, TrialDistance.FAR_3M),
            trial(1.0, 1.0, TrialSurface.TABLE_EDGE, TrialDistance.NEAR_1M),
            trial(1.0, 1.0, TrialSurface.FLOOR, TrialDistance.FAR_3M),
            trial(1.0, 1.0, TrialSurface.OTHER, TrialDistance.NEAR_1M),
            trial(1.0, 1.0, TrialSurface.FLOOR, TrialDistance.NEAR_1M),
            trial(1.0, 1.0, TrialSurface.TABLE_EDGE, TrialDistance.OTHER),
        )

        assertEquals(
            listOf(
                TrialSurface.FLOOR to TrialDistance.NEAR_1M,
                TrialSurface.FLOOR to TrialDistance.FAR_3M,
                TrialSurface.TABLE_EDGE to TrialDistance.NEAR_1M,
                TrialSurface.TABLE_EDGE to TrialDistance.OTHER,
                TrialSurface.OTHER to TrialDistance.NEAR_1M,
                TrialSurface.OTHER to TrialDistance.FAR_3M,
            ),
            summarizeTrials(trials).map { it.surface to it.nominalDistance },
        )
    }

    private fun trial(
        errorCm: Double,
        errorPct: Double,
        surface: TrialSurface = TrialSurface.FLOOR,
        distance: TrialDistance = TrialDistance.NEAR_1M,
    ) = MeasurementTrial(
        index = 1,
        label = "test",
        surface = surface,
        nominalDistance = distance,
        recordedAtUtc = "2026-10-11T00:00:00Z",
        tapeCm = 100.0,
        arcoreM = 1.0,
        errorCm = errorCm,
        errorPct = errorPct,
        hitTypes = emptyList(),
        trackingAtMeasure = "TRACKING",
        anchorTrackingAtMeasure = emptyList(),
    )
}
