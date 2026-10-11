package com.roomrelay.app.core

enum class HitKind {
    DEPTH_POINT,
    PLANE,
    POINT,
    INSTANT_PLACEMENT_POINT,
    OTHER,
}

interface HitCandidate {
    val kind: HitKind
    val isPoseInPlanePolygon: Boolean
    val hasEstimatedSurfaceNormal: Boolean
}

object HitSelectionPolicy {
    fun <T : HitCandidate> select(hitsNearestFirst: List<T>): T? =
        hitsNearestFirst.firstOrNull { it.kind == HitKind.DEPTH_POINT }
            ?: hitsNearestFirst.firstOrNull {
                it.kind == HitKind.PLANE && it.isPoseInPlanePolygon
            }
            ?: hitsNearestFirst.firstOrNull {
                it.kind == HitKind.POINT && it.hasEstimatedSurfaceNormal
            }

    fun label(candidate: HitCandidate): String = when (candidate.kind) {
        HitKind.DEPTH_POINT -> "DEPTH_POINT"
        HitKind.PLANE -> "PLANE"
        HitKind.POINT -> "POINT_SURFACE_NORMAL"
        HitKind.INSTANT_PLACEMENT_POINT -> "INSTANT_PLACEMENT_POINT"
        HitKind.OTHER -> "OTHER"
    }
}
