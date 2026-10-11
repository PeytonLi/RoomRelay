package com.roomrelay.app.core.inference

import org.junit.Assert.assertEquals
import org.junit.Test

class YuvToArgbTest {

    private fun uniformYuv(
        w: Int,
        h: Int,
        y: Int,
        u: Int,
        v: Int,
        uvPixelStride: Int = 1,
    ): YuvImage {
        val yPlane = ByteArray(w * h) { y.toByte() }
        val chroma = ByteArray((w / 2) * (h / 2) * uvPixelStride)
        for (i in chroma.indices step uvPixelStride) {
            chroma[i] = if ((i / uvPixelStride) % 2 == 0) u.toByte() else v.toByte()
        }
        // Build u/v planes honoring pixelStride (interleaved layout).
        val uPlane = ByteArray((w / 2) * (h / 2) * uvPixelStride)
        val vPlane = ByteArray((w / 2) * (h / 2) * uvPixelStride)
        for (row in 0 until h / 2) {
            for (col in 0 until w / 2) {
                val idx = (row * (w / 2) + col) * uvPixelStride
                uPlane[idx] = u.toByte()
                vPlane[idx] = v.toByte()
            }
        }
        return YuvImage(
            width = w, height = h,
            yPlane = yPlane, uPlane = uPlane, vPlane = vPlane,
            yRowStride = w,
            uvRowStride = (w / 2) * uvPixelStride,
            uvPixelStride = uvPixelStride,
        )
    }

    @Test
    fun `neutral gray conversion`() {
        val src = uniformYuv(8, 8, y = 128, u = 128, v = 128)
        val out = YuvToArgb.convert(src, 0)
        assertEquals(0xFF808080.toInt(), out.image.pixels[0])
        assertEquals(8, out.image.width)
        assertEquals(8, out.image.height)
    }

    @Test
    fun `downscale respects max long side`() {
        val src = uniformYuv(960, 720, y = 128, u = 128, v = 128)
        val out = YuvToArgb.convert(src, 0)
        assertEquals(480, out.image.width)
        assertEquals(360, out.image.height)
    }

    @Test
    fun `interleaved pixel stride 2 uv`() {
        // pixelStride=2: u at even bytes, v at odd bytes of the same buffer,
        // represented here as separate strided planes.
        val src = uniformYuv(8, 8, y = 81, u = 90, v = 240, uvPixelStride = 2)
        val out = YuvToArgb.convert(src, 0)
        // BT.601: r = 81 + 1.402*112 ≈ 238; g = 81 - 0.344*(-38) - 0.714*112 ≈ 14;
        // b = 81 + 1.772*(-38) ≈ 13
        val px = out.image.pixels[0]
        assertEquals(0xFF shl 24 or (238 shl 16) or (14 shl 8) or 13, px)
    }

    @Test
    fun `rotation 90 moves corner`() {
        // Distinct Y value in top-left source pixel.
        val src = uniformYuv(4, 2, y = 128, u = 128, v = 128)
        src.yPlane[0] = 255.toByte()
        val out = YuvToArgb.convert(src, 90)
        assertEquals(2, out.image.width)
        assertEquals(4, out.image.height)
        // 90 CW: src (0,0) -> dest (h-1, 0) = (1, 0).
        assertEquals(0xFFFFFFFF.toInt(), out.image.pixels[1])
        assertEquals(0xFF808080.toInt(), out.image.pixels[0])
    }
}
