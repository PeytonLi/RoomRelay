package com.roomrelay.app.core.inference

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val EPS = 1e-4f

class GeometryTest {

    @Test
    fun `rotation degrees formula`() {
        assertEquals(90, rotationDegrees(90, 0))
        assertEquals(0, rotationDegrees(90, 90))
        assertEquals(270, rotationDegrees(90, 180))
        assertEquals(180, rotationDegrees(90, 270))
        assertEquals(0, rotationDegrees(0, 0))
    }

    private fun sensorToUpright(box: BoxPx, rotationDeg: Int, w: Int, h: Int): BoxPx {
        val norm = rotationDeg
        val corners = listOf(
            box.left to box.top, box.right to box.top,
            box.right to box.bottom, box.left to box.bottom,
        ).map { (x, y) ->
            when (norm) {
                90 -> (h - 1f - y) to x
                180 -> (w - 1f - x) to (h - 1f - y)
                270 -> y to (w - 1f - x)
                else -> x to y
            }
        }
        return BoxPx(
            corners.minOf { it.first }, corners.minOf { it.second },
            corners.maxOf { it.first }, corners.maxOf { it.second },
        )
    }

    @Test
    fun `map box round trips for all rotations`() {
        val imageW = 640
        val imageH = 480
        val scale = 0.5f
        val sensorBox = BoxPx(50f, 40f, 300f, 200f)
        for (rotation in intArrayOf(0, 90, 180, 270)) {
            // Forward: sensor -> upright space (as YuvToArgb's rotation does),
            // then scaled into bitmap space.
            val upright = sensorToUpright(sensorBox, rotation, imageW, imageH)
            val bitmapBox = BoxPx(
                upright.left * scale, upright.top * scale,
                upright.right * scale, upright.bottom * scale,
            )
            // Inverse under test.
            val back = mapBoxToImagePixels(bitmapBox, rotation, imageW, imageH, scale)
            assertEquals(sensorBox.left, back.left, 2f)
            assertEquals(sensorBox.top, back.top, 2f)
            assertEquals(sensorBox.right, back.right, 2f)
            assertEquals(sensorBox.bottom, back.bottom, 2f)
        }
    }

    @Test
    fun `iou basics`() {
        val a = BoxPx(0f, 0f, 10f, 10f)
        val b = BoxPx(5f, 5f, 15f, 15f)
        assertEquals(25f / 175f, iou(a, b), EPS)
        assertEquals(1f, iou(a, a), EPS)
        assertEquals(0f, iou(a, BoxPx(20f, 20f, 30f, 30f)), EPS)
    }

    @Test
    fun `box contains`() {
        assertTrue(BoxPx(0f, 0f, 10f, 10f).contains(5f, 5f))
        assertTrue(!BoxPx(0f, 0f, 10f, 10f).contains(11f, 5f))
    }
}
