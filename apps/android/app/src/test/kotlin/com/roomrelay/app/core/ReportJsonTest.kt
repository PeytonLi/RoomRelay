package com.roomrelay.app.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportJsonTest {
    @Test
    fun roundTripsWithExactTopLevelKeysAndExplicitNullSession() {
        val report = sampleReport(sessionLog = null)
        val encoded = encodeReport(report)
        val decoded = decodeReport(encoded)

        assertEquals(report, decoded)
        val json = Json.parseToJsonElement(encoded).jsonObject
        assertEquals(
            listOf(
                "schemaVersion",
                "generatedAtUtc",
                "app",
                "device",
                "capabilities",
                "cameraConfigs",
                "measurements",
                "sessionLog",
                "notes",
            ),
            json.keys.toList(),
        )
        assertEquals(1, json["schemaVersion"]?.toString()?.toInt())
        assertEquals("null", json["sessionLog"].toString())
        assertTrue(findSensitiveKeys(json).isEmpty())

        val reportWithSession = sampleReport(
            SessionLog(
                startedAtUtc = "2026-10-11T00:00:00Z",
                durationTargetS = 60,
                endReason = "STOPPED_BY_USER",
                thermalStatusStart = "NONE",
                thermalStatusEnd = "LIGHT",
                depthMode = "AUTOMATIC",
                samples = emptyList(),
                breaks = emptyList(),
            ),
        )
        assertEquals(reportWithSession, decodeReport(encodeReport(reportWithSession)))
    }

    private fun sampleReport(sessionLog: SessionLog?) = ProbeReport(
        generatedAtUtc = "2026-10-11T00:00:00Z",
        app = AppInfo("com.roomrelay.app", "0.1.0-t002", 1L, "debug"),
        device = DeviceInfo("Samsung", "S24", "e3q", 36, "16"),
        capabilities = Capabilities(
            arServicesInstalled = true,
            arServicesVersionName = "1.56.0",
            arServicesVersionCode = 1L,
            availability = "SUPPORTED_INSTALLED",
            availabilityPolls = 1,
            installRequestResult = null,
            cameraPermission = "GRANTED",
            sessionCreated = true,
            sessionErrorClass = null,
            sessionErrorMessage = null,
            depthAutomaticSupported = true,
            rawDepthOnlySupported = true,
            activeCameraConfig = null,
            configureErrorClass = null,
        ),
        cameraConfigs = emptyList(),
        measurements = emptyList(),
        sessionLog = sessionLog,
        notes = "",
    )

    private fun findSensitiveKeys(value: kotlinx.serialization.json.JsonElement): List<String> =
        when (value) {
            is JsonObject -> value.flatMap { (key, child) ->
                val lower = key.lowercase()
                buildList {
                    if (listOf("serial", "imei", "androidid", "advertising").any(lower::contains)) {
                        add(key)
                    }
                    addAll(findSensitiveKeys(child))
                }
            }
            is JsonArray -> value.flatMap(::findSensitiveKeys)
            else -> emptyList()
        }
}
