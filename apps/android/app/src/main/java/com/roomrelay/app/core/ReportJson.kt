package com.roomrelay.app.core

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

private val reportJson = Json {
    prettyPrint = true
    encodeDefaults = true
    explicitNulls = true
}

fun encodeReport(report: ProbeReport): String = reportJson.encodeToString(report)

fun decodeReport(json: String): ProbeReport = reportJson.decodeFromString(json)
