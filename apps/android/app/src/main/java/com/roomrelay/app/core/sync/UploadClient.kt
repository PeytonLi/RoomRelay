package com.roomrelay.app.core.sync

import com.roomrelay.app.core.capture.CaptureSession
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.min
import kotlin.math.pow
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

interface Sleeper {
    fun sleep(ms: Long)
}

object RealSleeper : Sleeper {
    override fun sleep(ms: Long) {
        Thread.sleep(ms)
    }
}

interface ClientClock {
    fun nowMs(): Long
}

object SystemClientClock : ClientClock {
    override fun nowMs(): Long = System.currentTimeMillis()
}

const val DEFAULT_PART_SIZE_BYTES = 5L * 1024 * 1024
const val MAX_STEP_ATTEMPTS = 5
const val MAX_URL_REFRESHES = 2
const val BACKOFF_BASE_MS = 1_000L
const val BACKOFF_CAP_MS = 30_000L
const val ASSET_LOCAL_ID = "capture-manifest"

/**
 * Synchronous upload worker for queued captures. The app runs it on a
 * background executor at launch (resume after kill) and from a "Sync now"
 * action. Never fabricates tokens; never sends the bearer token to object
 * storage.
 */
class UploadClient(
    private val http: OkHttpClient,
    private val store: FileUploadQueueStore,
    private val auth: AuthTokenProvider,
    private val configProvider: () -> SyncConfig,
    private val sleeper: Sleeper = RealSleeper,
    private val clock: ClientClock = SystemClientClock,
    private val random: java.util.Random = java.util.Random(),
    private val defaultPartSizeBytes: Long = DEFAULT_PART_SIZE_BYTES,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }
    private val jsonMedia = "application/json".toMediaType()
    private val octetMedia = "application/octet-stream".toMediaType()

    fun enqueue(
        capture: CaptureSession,
        payload: ByteArray,
        partSizeBytes: Long = defaultPartSizeBytes,
    ): UploadJob {
        store.list().firstOrNull { it.clientCaptureId == capture.clientCaptureId }?.let {
            return it
        }
        val jobId = UUID.randomUUID().toString()
        store.savePayload(jobId, payload)
        val job = UploadJob(
            jobId = jobId,
            idempotencyKey = UUID.randomUUID().toString(),
            clientCaptureId = capture.clientCaptureId,
            kind = capture.kind.name,
            consentVersion = capture.consentVersion,
            device = mapOf(
                "manufacturer" to capture.device.manufacturer,
                "model" to capture.device.model,
                "sdkInt" to capture.device.sdkInt.toString(),
                "appVersion" to capture.device.appVersion,
                "arcoreSdkVersion" to capture.device.arcoreSdkVersion,
                "detectorModelId" to capture.device.detectorModelId,
            ),
            payloadSha256 = sha256Hex(payload),
            payloadBytes = payload.size.toLong(),
            partSizeBytes = partSizeBytes,
            updatedAtMs = clock.nowMs(),
        )
        store.save(job)
        return job
    }

    private fun pendingJobs(): List<UploadJob> {
        val now = clock.nowMs()
        return store.list().filter {
            it.status == UploadStatus.PENDING || it.status == UploadStatus.RUNNING ||
                (it.status == UploadStatus.RETRY_SCHEDULED && (it.nextAttemptAtMs ?: 0L) <= now)
        }
    }

    /** Marks queued jobs unavailable with a plain-language reason. */
    private fun markUnavailable(reason: String, status: UploadStatus): List<UploadJob> =
        store.list().map { job ->
            if (job.status == UploadStatus.PENDING || job.status == UploadStatus.RETRY_SCHEDULED ||
                job.status == UploadStatus.RUNNING
            ) {
                save(job.copy(status = status, lastError = reason, updatedAtMs = clock.nowMs()))
            } else {
                job
            }
        }

    /** Processes all due pending jobs; returns the refreshed job list. */
    fun runPending(): List<UploadJob> {
        val config = configProvider()
        if (config !is SyncConfig.Available) {
            val reason = (config as? SyncConfig.Unavailable)?.reason ?: "Sync unavailable"
            if (pendingJobs().isEmpty()) return store.list()
            return markUnavailable(reason, UploadStatus.AUTH_UNAVAILABLE)
        }
        val token = when (val t = auth.currentToken()) {
            is TokenResult.Available -> t.token
            is TokenResult.Unavailable -> {
                if (pendingJobs().isEmpty()) return store.list()
                return markUnavailable(t.reason, UploadStatus.AUTH_UNAVAILABLE)
            }
        }
        pendingJobs().forEach { runJob(it, config.baseUrl, token) }
        return store.list()
    }

    fun listJobs(): List<UploadJob> = store.list()

    private fun runJob(startJob: UploadJob, baseUrl: String, token: String) {
        var job = save(
            startJob.copy(status = UploadStatus.RUNNING, attempts = 0, updatedAtMs = clock.nowMs()),
        )
        while (job.step != UploadStep.DONE) {
            when (val outcome = runStepWithRetry(job, baseUrl, token)) {
                is StepOutcome.Advance -> job = advance(job, outcome)
                is StepOutcome.RefreshUrls -> {
                    val refreshCount = job.refreshCount + 1
                    if (refreshCount > MAX_URL_REFRESHES) {
                        save(
                            job.copy(
                                status = UploadStatus.FAILED,
                                lastError = outcome.reason,
                                updatedAtMs = clock.nowMs(),
                            ),
                        )
                        return
                    }
                    job = save(
                        job.copy(
                            step = UploadStep.REQUEST_UPLOAD,
                            refreshCount = refreshCount,
                            attempts = 0,
                            updatedAtMs = clock.nowMs(),
                        ),
                    )
                }
                is StepOutcome.Retry -> {
                    // Reload so per-part progress persisted mid-step survives.
                    val latest = store.load(job.jobId) ?: job
                    save(
                        latest.copy(
                            status = UploadStatus.RETRY_SCHEDULED,
                            lastError = outcome.error,
                            nextAttemptAtMs = clock.nowMs() +
                                backoffMs(job.attempts + 1, outcome.retryAfterMs),
                            updatedAtMs = clock.nowMs(),
                        ),
                    )
                    return
                }
                is StepOutcome.Terminal -> {
                    save(
                        job.copy(
                            status = outcome.status,
                            lastError = outcome.error,
                            updatedAtMs = clock.nowMs(),
                        ),
                    )
                    return
                }
            }
        }
        save(
            job.copy(
                status = UploadStatus.COMPLETED,
                lastError = null,
                updatedAtMs = clock.nowMs(),
            ),
        )
    }

    private fun advance(job: UploadJob, outcome: StepOutcome.Advance): UploadJob = save(
        job.copy(
            serverCaptureId = outcome.captureId ?: job.serverCaptureId,
            assetId = outcome.assetId ?: job.assetId,
            parts = if (outcome.parts.isNotEmpty()) outcome.parts else job.parts,
            step = when (job.step) {
                UploadStep.CREATE -> UploadStep.REQUEST_UPLOAD
                UploadStep.REQUEST_UPLOAD -> UploadStep.PUT_PARTS
                UploadStep.PUT_PARTS -> UploadStep.FINALIZE
                else -> UploadStep.DONE
            },
            attempts = 0,
            updatedAtMs = clock.nowMs(),
        ),
    )

    /**
     * Runs one step up to MAX_STEP_ATTEMPTS times. A Retry outcome returned
     * here means attempts are exhausted and the caller persists
     * RETRY_SCHEDULED.
     */
    private fun runStepWithRetry(startJob: UploadJob, baseUrl: String, token: String): StepOutcome {
        var job = startJob
        var attempts = job.attempts
        while (true) {
            val outcome = runStepOnce(job, baseUrl, token)
            if (outcome !is StepOutcome.Retry) return outcome
            attempts += 1
            if (attempts >= MAX_STEP_ATTEMPTS) {
                return outcome
            }
            // Steps persist their own progress (e.g. finished parts); reload
            // so the attempts update never clobbers it.
            job = save(
                (store.load(job.jobId) ?: job)
                    .copy(attempts = attempts, updatedAtMs = clock.nowMs()),
            )
            sleeper.sleep(backoffMs(attempts, outcome.retryAfterMs))
        }
    }

    private fun runStepOnce(job: UploadJob, baseUrl: String, token: String): StepOutcome =
        when (job.step) {
            UploadStep.CREATE -> createCapture(job, baseUrl, token)
            UploadStep.REQUEST_UPLOAD -> requestUpload(job, baseUrl, token)
            UploadStep.PUT_PARTS -> putParts(job)
            UploadStep.FINALIZE -> finalizeCapture(job, baseUrl, token)
            UploadStep.DONE -> StepOutcome.Advance()
        }

    private sealed interface StepOutcome {
        data class Advance(
            val captureId: String? = null,
            val assetId: String? = null,
            val parts: List<PartState> = emptyList(),
        ) : StepOutcome

        data class Retry(val error: String, val retryAfterMs: Long? = null) : StepOutcome

        data class Terminal(val status: UploadStatus, val error: String) : StepOutcome

        /** Signed PUT URL rejected; re-request fresh part URLs. */
        data class RefreshUrls(val reason: String) : StepOutcome
    }

    private fun save(job: UploadJob): UploadJob {
        store.save(job)
        return job
    }

    private fun backoffMs(attempt: Int, retryAfterMs: Long?): Long {
        retryAfterMs?.let { return it }
        val cap = min(BACKOFF_CAP_MS.toDouble(), BACKOFF_BASE_MS * 2.0.pow(attempt - 1))
        return (random.nextDouble() * cap).toLong().coerceAtLeast(1L)
    }

    private fun apiRequest(baseUrl: String, path: String, token: String): Request.Builder =
        Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer $token")

    private sealed interface HttpResult {
        data class Ok(val headers: Map<String, String>, val body: String) : HttpResult

        data class Failure(
            val code: Int,
            val error: ApiError?,
            val retryAfterMs: Long?,
        ) : HttpResult

        data class Io(val exception: IOException) : HttpResult
    }

    private fun execute(request: Request): HttpResult = try {
        http.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (response.isSuccessful) {
                val headers = response.headers.names().associateWith {
                    response.header(it).orEmpty()
                }
                HttpResult.Ok(headers, body)
            } else {
                HttpResult.Failure(
                    response.code,
                    parseError(body),
                    response.header("Retry-After")?.toLongOrNull()?.let { it * 1000 },
                )
            }
        }
    } catch (exception: IOException) {
        HttpResult.Io(exception)
    }

    private fun parseError(body: String): ApiError? = try {
        json.decodeFromString<ApiError>(body)
    } catch (_: Exception) {
        null
    }

    private fun errorText(result: HttpResult.Failure): String =
        result.error?.let { "${it.code}: ${it.message}" } ?: "HTTP ${result.code}"

    /** Maps an HTTP failure to a step outcome using the sync error contract. */
    private fun classify(
        result: HttpResult,
        captureScoped: Boolean = true,
    ): StepOutcome = when (result) {
        is HttpResult.Io -> StepOutcome.Retry(
            "${result.exception.javaClass.simpleName}: ${result.exception.message}",
        )
        is HttpResult.Ok -> error("Ok is not a failure")
        is HttpResult.Failure -> {
            val retryableStatus = result.code == 408 || result.code == 429 || result.code >= 500
            when {
                result.code == 401 -> StepOutcome.Terminal(
                    UploadStatus.AUTH_REQUIRED,
                    errorText(result),
                )
                result.code == 403 && captureScoped -> StepOutcome.Terminal(
                    UploadStatus.FORBIDDEN,
                    errorText(result),
                )
                result.code == 404 && captureScoped -> StepOutcome.Terminal(
                    UploadStatus.NOT_FOUND,
                    errorText(result),
                )
                retryableStatus || result.error?.retryable == true ->
                    StepOutcome.Retry(errorText(result), result.retryAfterMs)
                else -> StepOutcome.Terminal(UploadStatus.FAILED, errorText(result))
            }
        }
    }

    private fun createCapture(job: UploadJob, baseUrl: String, token: String): StepOutcome {
        val body = json.encodeToString(
            CreateCaptureRequest.serializer(),
            CreateCaptureRequest(job.clientCaptureId, job.kind, job.consentVersion, job.device),
        ).toRequestBody(jsonMedia)
        val request = apiRequest(baseUrl, "/api/v1/captures", token)
            .header("Idempotency-Key", "${job.idempotencyKey}:create")
            .post(body)
            .build()
        return when (val result = execute(request)) {
            is HttpResult.Ok -> {
                val id = try {
                    json.decodeFromString<CreateCaptureResponse>(result.body).id
                } catch (_: Exception) {
                    return StepOutcome.Terminal(UploadStatus.FAILED, "Unparseable create response")
                }
                StepOutcome.Advance(captureId = id)
            }
            else -> classify(result)
        }
    }

    private fun requestUpload(job: UploadJob, baseUrl: String, token: String): StepOutcome {
        val captureId = job.serverCaptureId
            ?: return StepOutcome.Terminal(UploadStatus.FAILED, "Missing server capture id")
        val partCount = ((job.payloadBytes + job.partSizeBytes - 1) / job.partSizeBytes).toInt()
        val body = json.encodeToString(
            RequestUploadRequest.serializer(),
            RequestUploadRequest(
                assetRole = "CAPTURE_MANIFEST",
                contentType = "application/json",
                bytes = job.payloadBytes,
                sha256 = job.payloadSha256,
                partSizeBytes = job.partSizeBytes,
                partCount = partCount,
            ),
        ).toRequestBody(jsonMedia)
        val request = apiRequest(baseUrl, "/api/v1/captures/$captureId/uploads", token)
            .header("Idempotency-Key", "${job.idempotencyKey}:upload:$ASSET_LOCAL_ID")
            .post(body)
            .build()
        return when (val result = execute(request)) {
            is HttpResult.Ok -> {
                val response = try {
                    json.decodeFromString<RequestUploadResponse>(result.body)
                } catch (_: Exception) {
                    return StepOutcome.Terminal(UploadStatus.FAILED, "Unparseable upload response")
                }
                val completed = response.completedParts.toSet()
                // Keep ETags for parts the server already has.
                val parts = response.parts.map { part ->
                    val existing = job.parts.firstOrNull { it.partNumber == part.partNumber }
                    PartState(
                        partNumber = part.partNumber,
                        url = part.url,
                        etag = existing?.etag,
                        done = part.partNumber in completed || existing?.done == true,
                    )
                }
                StepOutcome.Advance(assetId = response.assetId, parts = parts)
            }
            else -> classify(result)
        }
    }

    private fun putParts(job: UploadJob): StepOutcome {
        val payload = try {
            store.payloadPath(job.jobId).readBytes()
        } catch (exception: IOException) {
            return StepOutcome.Terminal(UploadStatus.FAILED, "Payload missing: ${exception.message}")
        }
        val parts = job.parts.toMutableList()
        for (index in parts.indices) {
            val part = parts[index]
            if (part.done) continue
            val url = part.url
                ?: return StepOutcome.RefreshUrls("Part ${part.partNumber} has no upload URL")
            val start = (part.partNumber - 1) * job.partSizeBytes
            val end = min(start + job.partSizeBytes, payload.size.toLong())
            if (start >= payload.size) {
                return StepOutcome.Terminal(UploadStatus.FAILED, "Part ${part.partNumber} beyond payload")
            }
            val slice = payload.copyOfRange(start.toInt(), end.toInt())
            // No Authorization header: the bearer token must never reach
            // object storage.
            val request = Request.Builder()
                .url(url)
                .put(slice.toRequestBody(octetMedia))
                .build()
            when (val result = execute(request)) {
                is HttpResult.Ok -> {
                    parts[index] = part.copy(done = true, etag = result.headers["etag"] ?: result.headers["ETag"])
                    save(job.copy(parts = parts.toList(), updatedAtMs = clock.nowMs()))
                }
                is HttpResult.Failure ->
                    return if (result.code == 403 || result.code == 400) {
                        StepOutcome.RefreshUrls(errorText(result))
                    } else {
                        classify(result)
                    }
                is HttpResult.Io -> return classify(result)
            }
        }
        return StepOutcome.Advance(parts = parts.toList())
    }

    private fun finalizeCapture(job: UploadJob, baseUrl: String, token: String): StepOutcome {
        val captureId = job.serverCaptureId
            ?: return StepOutcome.Terminal(UploadStatus.FAILED, "Missing server capture id")
        val assetId = job.assetId
            ?: return StepOutcome.Terminal(UploadStatus.FAILED, "Missing asset id")
        val body = json.encodeToString(
            FinalizeRequest.serializer(),
            FinalizeRequest(
                listOf(
                    FinalizeAsset(
                        assetId = assetId,
                        sha256 = job.payloadSha256,
                        bytes = job.payloadBytes,
                        parts = job.parts.map { FinalizePart(it.partNumber, it.etag ?: "") },
                    ),
                ),
            ),
        ).toRequestBody(jsonMedia)
        val request = apiRequest(baseUrl, "/api/v1/captures/$captureId/finalize", token)
            .header("Idempotency-Key", "${job.idempotencyKey}:finalize")
            .post(body)
            .build()
        return when (val result = execute(request)) {
            is HttpResult.Ok -> StepOutcome.Advance()
            is HttpResult.Failure ->
                if (result.code == 409 && result.error?.code == "ALREADY_FINALIZED") {
                    StepOutcome.Advance()
                } else {
                    classify(result)
                }
            is HttpResult.Io -> classify(result)
        }
    }

    companion object {
        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString("") { "%02x".format(it) }
    }
}
