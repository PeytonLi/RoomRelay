package com.roomrelay.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

class MeasurementMathTest {
    @Test
    fun distanceUsesEuclideanLength() {
        assertEquals(5.0, distanceMeters(Vec3(0.0, 0.0, 0.0), Vec3(3.0, 4.0, 0.0)), 0.0)
        assertEquals(1.0, distanceMeters(Vec3(0.0, 0.0, 0.0), Vec3(0.6, 0.0, 0.8)), 1e-12)
    }

    @Test
    fun errorsAreSignedRelativeToTape() {
        val longer = computeError(100.0, 1.02)!!
        assertEquals(2.0, longer.errorCm, 1e-9)
        assertEquals(2.0, longer.errorPct, 1e-9)

        val shorter = computeError(300.0, 2.91)!!
        assertEquals(-9.0, shorter.errorCm, 1e-9)
        assertEquals(-3.0, shorter.errorPct, 1e-9)
        assertNull(computeError(0.0, 1.0))
        assertNull(computeError(-1.0, 1.0))
        assertNull(computeError(Double.NaN, 1.0))
        assertNull(computeError(1.0, Double.POSITIVE_INFINITY))
    }

    @Test
    fun parsesDecimalCommaAndRejectsInvalidLengths() {
        assertEquals(123.4, parseTapeCm("123,4")!!, 0.0)
        assertEquals(123.4, parseTapeCm(" 123.4 ")!!, 0.0)
        listOf("", "abc", "0", "-5", "1e9", "10000.1", "1,2.3").forEach {
            assertNull(it, parseTapeCm(it))
        }
    }

    @Test
    fun formattingDoesNotDependOnDefaultLocale() {
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY)
            assertEquals("1.23 m", formatMeters(1.23))
            assertEquals("123.4 cm", formatCm(123.4))
            assertEquals("+2.0 cm", formatSignedCm(2.0))
            assertEquals("-3.0 %", formatSignedPct(-3.0))
        } finally {
            Locale.setDefault(previous)
        }
    }
}
