package com.roomrelay.app.core.capture

import java.io.File
import kotlinx.serialization.json.Json

/**
 * Draft captures persisted as JSON files so they survive an app kill. Writes
 * are atomic (temp file + rename).
 */
class CaptureDraftStore(private val dir: File) {
    private val json = Json {
        prettyPrint = true
        encodeDefaults = true
        explicitNulls = true
    }

    fun list(): List<CaptureSession> =
        dir.listFiles { f -> f.extension == "json" }.orEmpty()
            .mapNotNull { file ->
                try {
                    json.decodeFromString<CaptureSession>(file.readText())
                } catch (_: Exception) {
                    null
                }
            }
            .sortedBy { it.createdAtUtc }

    fun save(session: CaptureSession) {
        if (!dir.exists() && !dir.mkdirs()) {
            throw IllegalStateException("Draft directory could not be created")
        }
        val target = File(dir, "${session.clientCaptureId}.json")
        val tmp = File(dir, "${session.clientCaptureId}.json.tmp")
        tmp.writeText(json.encodeToString(CaptureSession.serializer(), session), Charsets.UTF_8)
        if (target.exists() && !target.delete()) {
            throw IllegalStateException("Draft file could not be replaced")
        }
        if (!tmp.renameTo(target)) {
            target.writeText(tmp.readText(), Charsets.UTF_8)
            tmp.delete()
        }
    }

    fun delete(clientCaptureId: String) {
        File(dir, "$clientCaptureId.json").delete()
    }
}
