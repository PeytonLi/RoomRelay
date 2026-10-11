package com.roomrelay.app.core.capture

import com.roomrelay.app.core.inference.RoomRelayCategory
import kotlinx.serialization.Serializable

enum class CaptureKind { ROOM, ITEM }

enum class CaptureAxis { WIDTH, DEPTH, HEIGHT }

enum class DimensionSource { USER_MEASURED, ARCORE_ESTIMATED }

@Serializable
data class DimensionMeasurement(
    val axis: CaptureAxis,
    val valueM: Double,
    val source: DimensionSource,
    val confirmedByUser: Boolean,
    val actor: String,
    val confirmedAtUtc: String,
    val revision: Int,
    val hitTypes: List<String>? = null,
    val trackingState: String? = null,
    val uncertaintyM: Double? = null,
)

@Serializable
data class CaptureAnchor(
    val translation: List<Double>,
    val rotationQuaternion: List<Double>,
    val hitType: String,
    val trackingStateAtConfirm: String,
    val confirmedAtUtc: String,
)

/** Detection evidence only — never raw pixels. */
@Serializable
data class DetectionEvidence(
    val cocoLabel: String,
    val score: Float,
    val frameTimeNs: Long,
    val boxImagePx: List<Float>,
)

@Serializable
data class CapturedItem(
    val localId: String,
    val category: RoomRelayCategory,
    val categoryCocoLabel: String? = null,
    val categoryScore: Float? = null,
    val categoryModelId: String? = null,
    val freeTextLabel: String? = null,
    val anchor: CaptureAnchor? = null,
    val dimensions: List<DimensionMeasurement> = emptyList(),
    val detectionEvidence: DetectionEvidence? = null,
)

@Serializable
data class CaptureDevice(
    val manufacturer: String,
    val model: String,
    val sdkInt: Int,
    val appVersion: String,
    val arcoreSdkVersion: String,
    val detectorModelId: String,
)

@Serializable
data class CaptureSession(
    val schemaVersion: Int = 1,
    val clientCaptureId: String,
    val kind: CaptureKind,
    val consentVersion: String,
    val createdAtUtc: String,
    val device: CaptureDevice,
    /** Session-local world frame; room registration is a server concern. */
    val frameId: String,
    val captureToRoomMatrix: List<Double>? = null,
    val items: List<CapturedItem> = emptyList(),
    val roomMeasurements: List<DimensionMeasurement> = emptyList(),
    val trackingBreaks: Int = 0,
)

fun CaptureSession.validateForUpload(): List<String> {
    val errors = mutableListOf<String>()
    when (kind) {
        CaptureKind.ITEM -> {
            if (items.size != 1) {
                errors += "An item capture needs exactly one item; this draft has ${items.size}."
            }
            val item = items.firstOrNull()
            if (item != null) {
                if (item.category == null) {
                    errors += "The item has no category."
                }
                CaptureAxis.entries.forEach { axis ->
                    val measurement = item.dimensions
                        .filter { it.axis == axis }
                        .maxByOrNull { it.revision }
                    if (measurement == null || !measurement.confirmedByUser) {
                        errors += "${axis.name.lowercase()} is not measured and confirmed yet."
                    } else {
                        val v = measurement.valueM
                        if (!v.isFinite() || v <= 0.0 || v > 10.0) {
                            errors += "${axis.name.lowercase()} value ${v} m is outside the 0-10 m range."
                        }
                    }
                }
            }
        }
        CaptureKind.ROOM -> {
            val confirmed = roomMeasurements.count {
                it.confirmedByUser && it.valueM.isFinite() && it.valueM > 0.0
            }
            if (confirmed < 1) {
                errors += "A room capture needs at least one confirmed measurement."
            }
        }
    }
    return errors
}
