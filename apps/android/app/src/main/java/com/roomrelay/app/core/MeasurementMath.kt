package com.roomrelay.app.core

import java.util.Locale

data class Vec3(val x: Double, val y: Double, val z: Double)

fun distanceMeters(a: Vec3, b: Vec3): Double {
    val dx = a.x - b.x
    val dy = a.y - b.y
    val dz = a.z - b.z
    return kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
}

fun parseTapeCm(text: String): Double? {
    val normalized = text.trim()
    if (!normalized.matches(Regex("[+-]?(?:\\d+(?:[.,]\\d*)?|[.,]\\d+)"))) return null
    val value = normalized.replace(',', '.').toDoubleOrNull() ?: return null
    return value.takeIf { it.isFinite() && it > 0.0 && it <= 10_000.0 }
}

data class TrialError(val errorCm: Double, val errorPct: Double)

fun computeError(tapeCm: Double, arcoreM: Double): TrialError? {
    if (!tapeCm.isFinite() || !arcoreM.isFinite() || tapeCm <= 0.0) return null
    val errorCm = arcoreM * 100.0 - tapeCm
    if (!errorCm.isFinite()) return null
    val errorPct = errorCm / tapeCm * 100.0
    return errorPct.takeIf { it.isFinite() }?.let { TrialError(errorCm, it) }
}

fun formatMeters(meters: Double): String = String.format(Locale.ROOT, "%.2f m", meters)

fun formatCm(cm: Double): String = String.format(Locale.ROOT, "%.1f cm", cm)

fun formatSignedCm(cm: Double): String = String.format(Locale.ROOT, "%+.1f cm", cm)

fun formatSignedPct(percent: Double): String = String.format(Locale.ROOT, "%+.1f %%", percent)
