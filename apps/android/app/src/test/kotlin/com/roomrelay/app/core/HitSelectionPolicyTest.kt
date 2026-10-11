package com.roomrelay.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HitSelectionPolicyTest {
    @Test
    fun depthPointWinsOverPlane() {
        val plane = Hit(HitKind.PLANE, isPoseInPlanePolygon = true)
        val depth = Hit(HitKind.DEPTH_POINT)
        assertEquals(depth, HitSelectionPolicy.select(listOf(plane, depth)))
    }

    @Test
    fun estimatedNormalPointIsFallbackForPlaneOutsidePolygon() {
        val plane = Hit(HitKind.PLANE, isPoseInPlanePolygon = false)
        val point = Hit(HitKind.POINT, hasEstimatedSurfaceNormal = true)
        assertEquals(point, HitSelectionPolicy.select(listOf(plane, point)))
        assertNull(HitSelectionPolicy.select(listOf(Hit(HitKind.POINT))))
    }

    @Test
    fun instantPlacementAndOtherAreNeverSelected() {
        assertNull(
            HitSelectionPolicy.select(
                listOf(Hit(HitKind.INSTANT_PLACEMENT_POINT), Hit(HitKind.OTHER)),
            ),
        )
    }

    @Test
    fun selectsFirstEligibleCandidateInPriorityClass() {
        val first = Hit(HitKind.PLANE, isPoseInPlanePolygon = true)
        val second = Hit(HitKind.PLANE, isPoseInPlanePolygon = true)
        assertEquals(first, HitSelectionPolicy.select(listOf(first, second)))
        assertNull(HitSelectionPolicy.select(emptyList()))
    }

    private data class Hit(
        override val kind: HitKind,
        override val isPoseInPlanePolygon: Boolean = false,
        override val hasEstimatedSurfaceNormal: Boolean = false,
    ) : HitCandidate
}
