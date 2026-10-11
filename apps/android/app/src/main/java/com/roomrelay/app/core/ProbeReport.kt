package com.roomrelay.app.core

import kotlinx.serialization.Serializable

@Serializable
data class ProbeReport(
    val schemaVersion: Int = 2,
    val generatedAtUtc: String,
    val app: AppInfo,
    val device: DeviceInfo,
    val capabilities: Capabilities,
    val cameraConfigs: List<CameraConfigInfo>,
    val measurements: List<MeasurementTrial>,
    val sessionLog: SessionLog?,
    val notes: String,
    val detectorModel: DetectorModelInfo? = null,
    val inference: com.roomrelay.app.core.inference.InferenceTelemetrySnapshot? = null,
    val captures: List<com.roomrelay.app.core.capture.CaptureSession> = emptyList(),
)

/** Identity and pin of the on-device detector model; never the model bytes. */
@Serializable
data class DetectorModelInfo(
    val id: String,
    val url: String,
    val sha256: String,
)

@Serializable
data class AppInfo(
    val packageName: String,
    val versionName: String,
    val versionCode: Long,
    val buildType: String,
    val arcoreSdkVersion: String = "1.56.0",
)

@Serializable
data class DeviceInfo(
    val manufacturer: String,
    val model: String,
    val device: String,
    val sdkInt: Int,
    val release: String,
)

@Serializable
data class Capabilities(
    val arServicesInstalled: Boolean,
    val arServicesVersionName: String?,
    val arServicesVersionCode: Long?,
    val availability: String,
    val availabilityPolls: Int,
    val installRequestResult: String?,
    val cameraPermission: String,
    val sessionCreated: Boolean,
    val sessionErrorClass: String?,
    val sessionErrorMessage: String?,
    val depthAutomaticSupported: Boolean?,
    val rawDepthOnlySupported: Boolean?,
    val activeCameraConfig: CameraConfigInfo?,
    val configureErrorClass: String?,
)

@Serializable
data class CameraConfigInfo(
    val cameraId: String,
    val facing: String,
    val imageWidth: Int,
    val imageHeight: Int,
    val textureWidth: Int,
    val textureHeight: Int,
    val fpsMin: Int,
    val fpsMax: Int,
    val depthSensorUsage: String,
    val stereoCameraUsage: String,
)

@Serializable
data class MeasurementTrial(
    val index: Int,
    val label: String,
    val recordedAtUtc: String,
    val tapeCm: Double,
    val arcoreM: Double,
    val errorCm: Double,
    val errorPct: Double,
    val hitTypes: List<String>,
    val trackingAtMeasure: String,
    val anchorTrackingAtMeasure: List<String>,
)
