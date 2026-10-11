package com.roomrelay.app.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ExportSchemaTest {

    private fun sampleReport(): ProbeReport = ProbeReport(
        generatedAtUtc = "2026-01-01T00:00:00Z",
        app = AppInfo("com.roomrelay.app", "0.2.0-t007", 1L, "debug"),
        device = DeviceInfo("Google", "Pixel", "pixel", 34, "15"),
        capabilities = Capabilities(
            arServicesInstalled = true,
            arServicesVersionName = "1",
            arServicesVersionCode = 1L,
            availability = "SUPPORTED_INSTALLED",
            availabilityPolls = 1,
            installRequestResult = null,
            cameraPermission = "GRANTED",
            sessionCreated = true,
            sessionErrorClass = null,
            sessionErrorMessage = null,
            depthAutomaticSupported = true,
            rawDepthOnlySupported = false,
            activeCameraConfig = null,
            configureErrorClass = null,
        ),
        cameraConfigs = emptyList(),
        measurements = emptyList(),
        sessionLog = null,
        notes = "",
        detectorModel = DetectorModelInfo(
            id = "efficientdet_lite0:int8:1",
            url = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
            sha256 = "0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb",
        ),
        inference = com.roomrelay.app.core.inference.InferenceTelemetrySnapshot(
            submitted = 5,
            completed = 4,
        ),
    )

    @Test
    fun `v2 report round trips`() {
        val json = encodeReport(sampleReport())
        val decoded = decodeReport(json)
        assertEquals(3, decoded.schemaVersion)
        assertEquals("efficientdet_lite0:int8:1", decoded.detectorModel?.id)
        assertEquals(5L, decoded.inference?.submitted)
    }

    @Test
    fun `v1 fixture json still decodes`() {
        val v1 = """
            {
              "schemaVersion": 1,
              "generatedAtUtc": "2025-01-01T00:00:00Z",
              "app": {"packageName":"com.roomrelay.app","versionName":"0.1.0-t002","versionCode":1,"buildType":"debug"},
              "device": {"manufacturer":"Google","model":"Pixel","device":"pixel","sdkInt":34,"release":"15"},
              "capabilities": {"arServicesInstalled":true,"arServicesVersionName":"1","arServicesVersionCode":1,"availability":"SUPPORTED_INSTALLED","availabilityPolls":1,"installRequestResult":null,"cameraPermission":"GRANTED","sessionCreated":true,"sessionErrorClass":null,"sessionErrorMessage":null,"depthAutomaticSupported":true,"rawDepthOnlySupported":false,"activeCameraConfig":null,"configureErrorClass":null},
              "cameraConfigs": [],
              "measurements": [],
              "sessionLog": null,
              "notes": ""
            }
        """.trimIndent()
        val decoded = decodeReport(v1)
        assertEquals(1, decoded.schemaVersion)
        assertEquals(null, decoded.detectorModel)
        assertEquals(null, decoded.inference)
        assertEquals(emptyList<com.roomrelay.app.core.capture.CaptureSession>(), decoded.captures)
    }

    @Test
    fun `export contains no image or pixel payload fields`() {
        val json = encodeReport(sampleReport())
        assertFalse(json.contains("\"bitmap\""))
        assertFalse(json.contains("\"image\""))
        assertFalse(json.contains("\"pixels\""))
        assertFalse(json.contains("base64"))
    }
}
