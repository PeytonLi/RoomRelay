package com.roomrelay.app.core.inference

import kotlin.math.max
import kotlin.math.min

/**
 * Display rotation needed to make the back-camera sensor image upright:
 * (sensor - display + 360) % 360.
 */
fun rotationDegrees(sensorOrientation: Int, displayRotationDeg: Int): Int =
    ((sensorOrientation - displayRotationDeg) % 360 + 360) % 360

/** Axis-aligned box in pixel coordinates. */
data class BoxPx(
    val left: Float,
    val top: Float,
    val right: Float,
    val bottom: Float,
) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val centerX: Float get() = (left + right) / 2f
    val centerY: Float get() = (top + bottom) / 2f

    fun contains(x: Float, y: Float): Boolean =
        x >= left && x <= right && y >= top && y <= bottom
}

fun iou(a: BoxPx, b: BoxPx): Float {
    val interW = min(a.right, b.right) - max(a.left, b.left)
    val interH = min(a.bottom, b.bottom) - max(a.top, b.top)
    if (interW <= 0f || interH <= 0f) return 0f
    val inter = interW * interH
    val union = a.width * a.height + b.width * b.height - inter
    return if (union <= 0f) 0f else inter / union
}

private fun rotatePointClockwise(
    x: Float,
    y: Float,
    width: Int,
    height: Int,
    rotationDeg: Int,
): Pair<Float, Float> = when (((rotationDeg % 360) + 360) % 360) {
    90 -> (height - 1f - y) to x
    180 -> (width - 1f - x) to (height - 1f - y)
    270 -> y to (width - 1f - x)
    else -> x to y
}

/**
 * Maps a detection box in the upright, scaled bitmap back to sensor-image
 * pixel coordinates. The detector bitmap was produced by downscaling the
 * sensor image by [scale] (output pixel = source pixel * scale) and then
 * rotating [rotationDeg] clockwise, so this applies the inverse rotation then
 * divides by scale. Inverse of [YuvToArgb]'s transform, and a round-trip
 * through both is covered by tests for 0/90/180/270.
 */
fun mapBoxToImagePixels(
    box: BoxPx,
    rotationDeg: Int,
    imageWidth: Int,
    imageHeight: Int,
    scale: Float,
): BoxPx {
    val norm = ((rotationDeg % 360) + 360) % 360
    // The rotation happened in downscaled bitmap space, so the inverse uses
    // the scaled dimensions (matching YuvToArgb's outW/outH).
    val outW = maxOf(1, (imageWidth * scale).toInt())
    val outH = maxOf(1, (imageHeight * scale).toInt())
    val uprightW = if (norm == 90 || norm == 270) outH else outW
    val uprightH = if (norm == 90 || norm == 270) outW else outH
    val inverse = (360 - norm) % 360
    val corners = listOf(
        box.left to box.top,
        box.right to box.top,
        box.right to box.bottom,
        box.left to box.bottom,
    ).map { (x, y) ->
        val (sx, sy) = rotatePointClockwise(x, y, uprightW, uprightH, inverse)
        (sx / scale) to (sy / scale)
    }
    val xs = corners.map { it.first }
    val ys = corners.map { it.second }
    return BoxPx(
        left = xs.min(),
        top = ys.min(),
        right = xs.max(),
        bottom = ys.max(),
    )
}
