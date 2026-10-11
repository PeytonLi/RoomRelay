package com.roomrelay.app.core.inference

import kotlin.math.max
import kotlin.math.min

/**
 * Plain-Kotlin copy of a YUV_420_888 camera image. Plane strides are honoured
 * so pixelStride=2 (interleaved UV) works.
 */
class YuvImage(
    val width: Int,
    val height: Int,
    val yPlane: ByteArray,
    val uPlane: ByteArray,
    val vPlane: ByteArray,
    val yRowStride: Int,
    val uvRowStride: Int,
    val uvPixelStride: Int,
)

class ArgbImage(
    val width: Int,
    val height: Int,
    val pixels: IntArray,
)

object YuvToArgb {
    const val MAX_LONG_SIDE = 480

    /**
     * Downscales [src] so its longest side is <= [maxLongSide] (nearest
     * neighbour), converts YUV_420_888 to ARGB (BT.601), then rotates the
     * output [rotationDeg] clockwise. Returns the ARGB image in upright space
     * plus the scale factor that maps upright pixels back to sensor pixels.
     */
    fun convert(
        src: YuvImage,
        rotationDeg: Int,
        maxLongSide: Int = MAX_LONG_SIDE,
        reuse: ArgbImage? = null,
    ): Converted {
        val scale = min(1f, maxLongSide.toFloat() / max(src.width, src.height))
        val outW = max(1, (src.width * scale).toInt())
        val outH = max(1, (src.height * scale).toInt())
        val norm = ((rotationDeg % 360) + 360) % 360
        val rotatedW = if (norm == 90 || norm == 270) outH else outW
        val rotatedH = if (norm == 90 || norm == 270) outW else outH
        val pixels = if (reuse != null &&
            reuse.width == rotatedW && reuse.height == rotatedH
        ) {
            reuse.pixels
        } else {
            IntArray(rotatedW * rotatedH)
        }
        for (oy in 0 until outH) {
            val sy = min(src.height - 1, (oy / scale).toInt())
            val yRow = sy * src.yRowStride
            val uvRow = (sy / 2) * src.uvRowStride
            for (ox in 0 until outW) {
                val sx = min(src.width - 1, (ox / scale).toInt())
                val yv = src.yPlane[yRow + sx].toInt() and 0xFF
                val uvIndex = uvRow + (sx / 2) * src.uvPixelStride
                val u = src.uPlane[uvIndex].toInt() and 0xFF
                val v = src.vPlane[uvIndex].toInt() and 0xFF
                pixels[rotatedIndex(ox, oy, outW, outH, norm, rotatedW)] =
                    yuvToArgb(yv, u, v)
            }
        }
        return Converted(ArgbImage(rotatedW, rotatedH, pixels), scale)
    }

    class Converted(val image: ArgbImage, val scale: Float)

    private fun rotatedIndex(
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        rotationDeg: Int,
        rotatedWidth: Int,
    ): Int = when (rotationDeg) {
        90 -> x * rotatedWidth + (height - 1 - y)
        180 -> (height - 1 - y) * rotatedWidth + (width - 1 - x)
        270 -> (width - 1 - x) * rotatedWidth + y
        else -> y * rotatedWidth + x
    }

    private fun yuvToArgb(y: Int, u: Int, v: Int): Int {
        val yF = y.toFloat()
        var r = (yF + 1.402f * (v - 128)).toInt()
        var g = (yF - 0.344136f * (u - 128) - 0.714136f * (v - 128)).toInt()
        var b = (yF + 1.772f * (u - 128)).toInt()
        r = r.coerceIn(0, 255)
        g = g.coerceIn(0, 255)
        b = b.coerceIn(0, 255)
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }
}
