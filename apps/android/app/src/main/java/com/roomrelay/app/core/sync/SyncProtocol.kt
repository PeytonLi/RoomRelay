package com.roomrelay.app.core.sync

import kotlinx.serialization.Serializable

/**
 * Client-side proposal of the docs/ARCHITECTURE.md A-04/A-06 capture-upload
 * contract. T-004 owns the server; this file is the single place both sides
 * align on shapes. Server contract:
 *   POST /api/v1/captures                    -> {id}
 *   POST /api/v1/captures/{id}/uploads       -> {assetId, parts[], completedParts[]}
 *   PUT  <signed part url>                   -> object storage, ETag in response
 *   POST /api/v1/captures/{id}/finalize      -> 200; 409 ALREADY_FINALIZED = ok
 * API calls carry Authorization: Bearer <token> and a unique Idempotency-Key;
 * signed-URL PUTs never carry the bearer token.
 * Errors use {code, message, retryable, correlationId}.
 */

@Serializable
data class CreateCaptureRequest(
    val clientCaptureId: String,
    val kind: String,
    val consentVersion: String,
    val device: Map<String, String>,
)

@Serializable
data class CreateCaptureResponse(val id: String)

@Serializable
data class RequestUploadRequest(
    val assetRole: String,
    val contentType: String,
    val bytes: Long,
    val sha256: String,
    val partSizeBytes: Long,
    val partCount: Int,
)

@Serializable
data class UploadPart(
    val partNumber: Int,
    val url: String,
    val expiresAt: String? = null,
)

@Serializable
data class RequestUploadResponse(
    val assetId: String,
    val parts: List<UploadPart> = emptyList(),
    val completedParts: List<Int> = emptyList(),
)

@Serializable
data class FinalizePart(val partNumber: Int, val etag: String)

@Serializable
data class FinalizeAsset(
    val assetId: String,
    val sha256: String,
    val bytes: Long,
    val parts: List<FinalizePart>,
)

@Serializable
data class FinalizeRequest(val assets: List<FinalizeAsset>)

@Serializable
data class ApiError(
    val code: String = "UNKNOWN",
    val message: String = "",
    val retryable: Boolean = false,
    val correlationId: String? = null,
)

sealed interface SyncConfig {
    data class Available(val baseUrl: String) : SyncConfig

    data class Unavailable(val reason: String) : SyncConfig

    companion object {
        fun parse(url: String, allowCleartext: Boolean = false): SyncConfig {
            val trimmed = url.trim()
            if (trimmed.isEmpty()) return Unavailable("No RoomRelay server configured")
            return if (trimmed.startsWith("https://") || (allowCleartext && trimmed.startsWith("http://"))) {
                Available(trimmed.trimEnd('/'))
            } else {
                Unavailable("Server URL must be https")
            }
        }
    }
}

interface AuthTokenProvider {
    fun currentToken(): TokenResult
}

sealed interface TokenResult {
    data class Available(val token: String) : TokenResult

    data class Unavailable(val reason: String) : TokenResult
}

class UnavailableAuthTokenProvider(
    private val reason: String = "Sign-in is not set up in this build",
) : AuthTokenProvider {
    override fun currentToken(): TokenResult = TokenResult.Unavailable(reason)
}
