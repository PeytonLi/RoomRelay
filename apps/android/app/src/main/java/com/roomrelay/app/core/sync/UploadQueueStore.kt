package com.roomrelay.app.core.sync

import java.io.File
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

enum class UploadStep { CREATE, REQUEST_UPLOAD, PUT_PARTS, FINALIZE, DONE }

enum class UploadStatus {
    PENDING,
    RUNNING,
    RETRY_SCHEDULED,
    AUTH_REQUIRED,
    AUTH_UNAVAILABLE,
    SYNC_UNAVAILABLE,
    FORBIDDEN,
    NOT_FOUND,
    FAILED,
    COMPLETED,
}

@Serializable
data class PartState(
    val partNumber: Int,
    val url: String? = null,
    val etag: String? = null,
    val done: Boolean = false,
)

@Serializable
data class UploadJob(
    val jobId: String,
    /** Generated once at enqueue; stable across process restarts. */
    val idempotencyKey: String,
    val clientCaptureId: String,
    val kind: String,
    val consentVersion: String,
    val device: Map<String, String> = emptyMap(),
    val payloadSha256: String,
    val payloadBytes: Long,
    val partSizeBytes: Long,
    val serverCaptureId: String? = null,
    val assetId: String? = null,
    val parts: List<PartState> = emptyList(),
    val step: UploadStep = UploadStep.CREATE,
    val status: UploadStatus = UploadStatus.PENDING,
    val attempts: Int = 0,
    val refreshCount: Int = 0,
    val lastError: String? = null,
    val nextAttemptAtMs: Long? = null,
    val updatedAtMs: Long = 0,
)

interface UploadQueueStore {
    fun list(): List<UploadJob>

    /** Job files that failed to parse (skipped, not fatal). */
    fun corruptFiles(): List<File>

    fun load(jobId: String): UploadJob?

    fun save(job: UploadJob)

    fun payloadPath(jobId: String): File
}

/**
 * One JSON file per job plus a payload file under [dir]. Every step and every
 * finished part is persisted atomically (temp + rename) so a kill mid-upload
 * resumes without re-sending finished work. RUNNING on disk means the process
 * died mid-step; it is loaded back as PENDING.
 */
class FileUploadQueueStore(private val dir: File) : UploadQueueStore {
    private val json = Json {
        encodeDefaults = true
        explicitNulls = true
        ignoreUnknownKeys = true
    }
    private val corrupt = mutableListOf<File>()

    private fun jobsDir() = File(dir, "jobs")

    private fun payloadsDir() = File(dir, "payloads")

    override fun list(): List<UploadJob> {
        corrupt.clear()
        val files = jobsDir().listFiles { f -> f.extension == "json" } ?: return emptyList()
        return files.mapNotNull { file ->
            try {
                val job = json.decodeFromString<UploadJob>(file.readText())
                if (job.status == UploadStatus.RUNNING) job.copy(status = UploadStatus.PENDING) else job
            } catch (_: Exception) {
                corrupt += file
                null
            }
        }.sortedBy { it.updatedAtMs }
    }

    override fun corruptFiles(): List<File> = corrupt.toList()

    override fun load(jobId: String): UploadJob? {
        val file = File(jobsDir(), "$jobId.json")
        if (!file.exists()) return null
        return try {
            val job = json.decodeFromString<UploadJob>(file.readText())
            if (job.status == UploadStatus.RUNNING) job.copy(status = UploadStatus.PENDING) else job
        } catch (_: Exception) {
            null
        }
    }

    override fun save(job: UploadJob) {
        val jobs = jobsDir()
        if (!jobs.exists() && !jobs.mkdirs()) {
            throw IllegalStateException("Upload queue directory could not be created")
        }
        val target = File(jobs, "${job.jobId}.json")
        val tmp = File(jobs, "${job.jobId}.json.tmp")
        tmp.writeText(json.encodeToString(UploadJob.serializer(), job), Charsets.UTF_8)
        if (target.exists() && !target.delete()) {
            throw IllegalStateException("Job file could not be replaced")
        }
        if (!tmp.renameTo(target)) {
            target.writeText(tmp.readText(), Charsets.UTF_8)
            tmp.delete()
        }
    }

    fun savePayload(jobId: String, payload: ByteArray) {
        val payloads = payloadsDir()
        if (!payloads.exists() && !payloads.mkdirs()) {
            throw IllegalStateException("Upload payload directory could not be created")
        }
        val target = File(payloads, "$jobId.bin")
        val tmp = File(payloads, "$jobId.bin.tmp")
        tmp.writeBytes(payload)
        if (target.exists() && !target.delete()) {
            throw IllegalStateException("Payload file could not be replaced")
        }
        if (!tmp.renameTo(target)) {
            target.writeBytes(tmp.readBytes())
            tmp.delete()
        }
    }

    override fun payloadPath(jobId: String): File = File(payloadsDir(), "$jobId.bin")
}
