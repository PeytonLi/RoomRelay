package com.roomrelay.app.core.capture

import com.roomrelay.app.core.inference.RoomRelayCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureValidationTest {

    private fun device() = CaptureDevice(
        manufacturer = "Google",
        model = "Pixel",
        sdkInt = 34,
        appVersion = "0.2.0-t007",
        arcoreSdkVersion = "1.56.0",
        detectorModelId = "efficientdet_lite0:int8:1",
    )

    private fun dim(axis: CaptureAxis, v: Double = 1.0, confirmed: Boolean = true) =
        DimensionMeasurement(
            axis = axis,
            valueM = v,
            source = DimensionSource.USER_MEASURED,
            confirmedByUser = confirmed,
            actor = "device-user",
            confirmedAtUtc = "2026-01-01T00:00:00Z",
            revision = 1,
        )

    private fun item(withDims: Boolean = true) = CapturedItem(
        localId = "i1",
        category = RoomRelayCategory.CHAIR,
        categorySource = CategorySource.USER_MANUAL,
        dimensions = if (withDims) {
            listOf(dim(CaptureAxis.WIDTH), dim(CaptureAxis.DEPTH), dim(CaptureAxis.HEIGHT))
        } else {
            emptyList()
        },
    )

    private fun session(kind: CaptureKind, items: List<CapturedItem> = listOf(item())) =
        CaptureSession(
            clientCaptureId = "c1",
            kind = kind,
            consentVersion = "capture-consent-v1",
            createdAtUtc = "2026-01-01T00:00:00Z",
            device = device(),
            frameId = "arcore-session:u1",
            items = items,
        )

    @Test
    fun `item capture needs exactly one item and three confirmed dims`() {
        assertTrue(session(CaptureKind.ITEM).validateForUpload().isEmpty())
        assertTrue(
            session(CaptureKind.ITEM, items = emptyList())
                .validateForUpload().isNotEmpty(),
        )
        assertTrue(
            session(CaptureKind.ITEM, items = listOf(item(withDims = false)))
                .validateForUpload().isNotEmpty(),
        )
    }

    @Test
    fun `out of range dimension rejected`() {
        val bad = item().copy(
            dimensions = listOf(
                dim(CaptureAxis.WIDTH, 0.0),
                dim(CaptureAxis.DEPTH, 1.0),
                dim(CaptureAxis.HEIGHT, 11.0),
            ),
        )
        val errors = session(CaptureKind.ITEM, listOf(bad)).validateForUpload()
        assertEquals(2, errors.size)
    }

    @Test
    fun `unconfirmed dimension rejected`() {
        val bad = item().copy(
            dimensions = listOf(
                dim(CaptureAxis.WIDTH),
                dim(CaptureAxis.DEPTH, confirmed = false),
                dim(CaptureAxis.HEIGHT),
            ),
        )
        assertTrue(
            session(CaptureKind.ITEM, listOf(bad)).validateForUpload()
                .any { it.contains("depth") },
        )
    }

    @Test
    fun `model detected item requires detection details`() {
        val missing = item().copy(
            categorySource = CategorySource.MODEL_DETECTED,
            categoryCocoLabel = "chair",
            categoryScore = null,
            categoryModelId = null,
        )
        assertTrue(
            session(CaptureKind.ITEM, listOf(missing)).validateForUpload()
                .any { it.contains("detection details") },
        )
        val complete = missing.copy(categoryScore = 0.9f, categoryModelId = "m1")
        assertTrue(
            session(CaptureKind.ITEM, listOf(complete)).validateForUpload().isEmpty(),
        )
    }

    @Test
    fun `room capture needs one confirmed measurement`() {
        assertTrue(
            session(CaptureKind.ROOM, items = emptyList())
                .copy(roomMeasurements = listOf(dim(CaptureAxis.WIDTH)))
                .validateForUpload().isEmpty(),
        )
        assertTrue(
            session(CaptureKind.ROOM, items = emptyList())
                .validateForUpload().isNotEmpty(),
        )
    }
}
