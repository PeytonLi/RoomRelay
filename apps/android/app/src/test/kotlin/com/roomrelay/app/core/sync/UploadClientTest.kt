package com.roomrelay.app.core.sync

import com.roomrelay.app.core.capture.CaptureDevice
import com.roomrelay.app.core.capture.CaptureKind
import com.roomrelay.app.core.capture.CaptureSession
import java.util.concurrent.TimeUnit
import java.io.File
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class UploadClientTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var store: FileUploadQueueStore
    private val sleeps = mutableListOf<Long>()
    private var nowMs = 0L

    private val sleeper = object : Sleeper {
        override fun sleep(ms: Long) {
            sleeps += ms
        }
    }
    private val clock = object : ClientClock {
        override fun nowMs(): Long = nowMs
    }

    private fun capture(id: String = "cap-1") = CaptureSession(
        clientCaptureId = id,
        kind = CaptureKind.ITEM,
        consentVersion = "capture-consent-v1",
        createdAtUtc = "2026-01-01T00:00:00Z",
        device = CaptureDevice("m", "m", 34, "0.2.0-t007", "1.56.0", "model"),
        frameId = "arcore-session:u1",
    )

    private fun client(
        baseUrl: String = server.url("/").toString().trimEnd('/'),
        auth: AuthTokenProvider = object : AuthTokenProvider {
            override fun currentToken() = TokenResult.Available("test-token")
        },
    ) = UploadClient(
        http = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build(),
        store = store,
        auth = auth,
        configProvider = { SyncConfig.parse(baseUrl, allowCleartext = true) },
        sleeper = sleeper,
        clock = clock,
        random = java.util.Random(0),
        defaultPartSizeBytes = PART_SIZE,
    )

    private fun enqueuePayload(client: UploadClient, bytes: Int = 120): UploadJob =
        client.enqueue(capture(), ByteArray(bytes) { it.toByte() }, PART_SIZE)

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        store = FileUploadQueueStore(tmp.root)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun respondHappy(partCount: Int) {
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                buildString {
                    append("""{"assetId":"asset-1","parts":[""")
                    append(
                        (1..partCount).joinToString(",") {
                            """{"partNumber":$it,"url":"${server.url("/part$it")}"}"""
                        },
                    )
                    append("""],"completedParts":[]}""")
                },
            ),
        )
        repeat(partCount) {
            server.enqueue(MockResponse().addHeader("ETag", "etag-${it + 1}"))
        }
        server.enqueue(MockResponse().setBody("{}"))
    }

    @Test
    fun `happy multipart upload`() {
        val job = enqueuePayload(client())
        respondHappy(3)
        client().runPending()
        val finished = store.load(job.jobId)
        assertEquals(UploadStatus.COMPLETED, finished?.status)
        // 6 requests: create, request-upload, 3 puts, finalize.
        assertEquals(6, server.requestCount)
        val create = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/captures", create.path)
        assertEquals("Bearer test-token", create.getHeader("Authorization"))
        assertEquals("${job.idempotencyKey}:create", create.getHeader("Idempotency-Key"))
        val uploadReq = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/captures/srv-1/uploads", uploadReq.path)
        assertEquals(
            "${job.idempotencyKey}:upload:$ASSET_LOCAL_ID",
            uploadReq.getHeader("Idempotency-Key"),
        )
        assertTrue(uploadReq.body.readUtf8().contains(job.payloadSha256))
        repeat(3) {
            val put = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertNull("no bearer on signed URL PUT", put.getHeader("Authorization"))
            assertEquals("application/octet-stream", put.getHeader("Content-Type"))
        }
        val finalize = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("/api/v1/captures/srv-1/finalize", finalize.path)
        assertEquals("${job.idempotencyKey}:finalize", finalize.getHeader("Idempotency-Key"))
    }

    @Test
    fun `interrupted mid part then succeeds`() {
        val job = enqueuePayload(client())
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"},{"partNumber":2,"url":"${server.url("/p2")}"},{"partNumber":3,"url":"${server.url("/p3")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY))
        repeat(4) {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY))
        }
        client().runPending()
        // 5 attempts exhausted -> RETRY_SCHEDULED, part persisted as not done.
        val failed = store.load(job.jobId)
        assertEquals(UploadStatus.RETRY_SCHEDULED, failed?.status)
        assertTrue(failed!!.nextAttemptAtMs != null)
        // Second run resumes and completes (clock advanced past the backoff).
        nowMs = 60_000_000L
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"},{"partNumber":2,"url":"${server.url("/p2")}"},{"partNumber":3,"url":"${server.url("/p3")}"}],"completedParts":[]}""",
            ),
        )
        repeat(3) { server.enqueue(MockResponse().addHeader("ETag", "e")) }
        server.enqueue(MockResponse().setBody("{}"))
        client().runPending()
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
    }

    @Test
    fun `simulated app kill resumes without re-sending finished work`() {
        var job = enqueuePayload(client())
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"},{"partNumber":2,"url":"${server.url("/p2")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().addHeader("ETag", "e1"))
        // Kill mid part 2: disconnects until attempts exhausted.
        repeat(5) {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY))
        }
        client().runPending()
        assertEquals(UploadStatus.RETRY_SCHEDULED, store.load(job.jobId)?.status)
        // New store+client on the same dir (as after an app kill).
        nowMs = 60_000_000L
        // Drain requests recorded by the first run so `paths` below only
        // contains the resumed run's calls.
        while (server.takeRequest(50, TimeUnit.MILLISECONDS) != null) {
        }
        val requestsBefore = server.requestCount
        val store2 = FileUploadQueueStore(tmp.root)
        val client2 = UploadClient(
            http = OkHttpClient(),
            store = store2,
            auth = object : AuthTokenProvider {
                override fun currentToken() = TokenResult.Available("test-token")
            },
            configProvider = {
                SyncConfig.parse(server.url("/").toString().trimEnd('/'), allowCleartext = true)
            },
            sleeper = sleeper,
            clock = clock,
            random = java.util.Random(0),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"},{"partNumber":2,"url":"${server.url("/p2")}"}],"completedParts":[1]}""",
            ),
        )
        server.enqueue(MockResponse().addHeader("ETag", "e2"))
        server.enqueue(MockResponse().setBody("{}"))
        client2.runPending()
        val paths = mutableListOf<String>()
        repeat(server.requestCount - requestsBefore) {
            paths += server.takeRequest(1, TimeUnit.SECONDS)!!.path!!
        }
        // No second POST /captures, and part 1 is not re-sent.
        assertTrue("paths=$paths", paths.none { it == "/api/v1/captures" })
        assertTrue("paths=$paths", paths.none { it == "/p1" })
        assertEquals(UploadStatus.COMPLETED, store2.load(job.jobId)?.status)
    }

    @Test
    fun `429 retry-after honored`() {
        enqueuePayload(client())
        server.enqueue(
            MockResponse().setResponseCode(429)
                .addHeader("Retry-After", "7")
                .setBody("""{"code":"RATE_LIMITED","message":"slow down","retryable":true}"""),
        )
        repeat(3) {
            server.enqueue(MockResponse().setResponseCode(429))
        }
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[],"completedParts":[1,2,3]}""",
            ),
        )
        server.enqueue(MockResponse().setBody("{}"))
        client().runPending()
        assertTrue("Retry-After slept: $sleeps", sleeps.contains(7000L))
        assertEquals(UploadStatus.COMPLETED, store.list().single().status)
    }

    @Test
    fun `duplicate finalize treated as completed`() {
        val job = enqueuePayload(client())
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().addHeader("ETag", "e1"))
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        repeat(3) { server.enqueue(MockResponse().setResponseCode(500).setBody("{}")) }
        server.enqueue(
            MockResponse().setResponseCode(409)
                .setBody("""{"code":"ALREADY_FINALIZED","message":"already done","retryable":false}"""),
        )
        client().runPending()
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
        val requests = (0 until server.requestCount).map {
            server.takeRequest(1, TimeUnit.SECONDS)!!
        }
        val finalizeKeys = requests
            .filter { it.path == "/api/v1/captures/srv-1/finalize" }
            .map { it.getHeader("Idempotency-Key") }
        assertTrue(finalizeKeys.isNotEmpty())
        assertTrue(finalizeKeys.all { it == "${job.idempotencyKey}:finalize" })
    }

    @Test
    fun `401 stops with auth required exactly one request`() {
        enqueuePayload(client())
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"UNAUTHORIZED"}"""))
        client().runPending()
        assertEquals(1, server.requestCount)
        assertEquals(UploadStatus.AUTH_REQUIRED, store.list().single().status)
    }

    @Test
    fun `unavailable token makes zero network calls`() {
        val c = client(
            auth = UnavailableAuthTokenProvider("Sign-in is not set up in this build"),
        )
        enqueuePayload(c)
        c.runPending()
        assertEquals(0, server.requestCount)
        assertEquals(UploadStatus.AUTH_UNAVAILABLE, store.list().single().status)
    }

    @Test
    fun `403 cross-user forbidden no retry`() {
        enqueuePayload(client())
        server.enqueue(
            MockResponse().setResponseCode(403)
                .setBody("""{"code":"FORBIDDEN","message":"different account"}"""),
        )
        client().runPending()
        assertEquals(1, server.requestCount)
        assertEquals(UploadStatus.FORBIDDEN, store.list().single().status)
    }

    @Test
    fun `empty base url unavailable zero requests`() {
        val c = client(baseUrl = "")
        enqueuePayload(c)
        c.runPending()
        assertEquals(0, server.requestCount)
        assertEquals(UploadStatus.SYNC_UNAVAILABLE, store.list().single().status)
    }

    @Test
    fun `auth unavailable job resumes once a token exists`() {
        val unavailable = client(
            auth = UnavailableAuthTokenProvider("Sign-in is not set up in this build"),
        )
        val job = enqueuePayload(unavailable)
        unavailable.runPending()
        assertEquals(0, server.requestCount)
        assertEquals(UploadStatus.AUTH_UNAVAILABLE, store.load(job.jobId)?.status)
        // A new client on the same dir with a working token resumes it.
        respondHappy(3)
        client().runPending()
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
        val creates = (0 until server.requestCount).map {
            server.takeRequest(1, TimeUnit.SECONDS)!!
        }.count { it.path == "/api/v1/captures" }
        assertEquals(1, creates)
    }

    @Test
    fun `force run ignores nextAttemptAtMs`() {
        val job = enqueuePayload(client())
        // Exhaust attempts so the job lands in RETRY_SCHEDULED in the future.
        repeat(5) {
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_DURING_REQUEST_BODY))
        }
        client().runPending()
        assertEquals(UploadStatus.RETRY_SCHEDULED, store.load(job.jobId)?.status)
        assertTrue(store.load(job.jobId)!!.nextAttemptAtMs!! > nowMs)
        // Non-forced run leaves it alone. Drain the request queue first so a
        // disconnect response still being counted server-side cannot leak into
        // the comparison.
        while (server.takeRequest(2, TimeUnit.SECONDS) != null) {
            // drain in-flight requests
        }
        val before = server.requestCount
        client().runPending()
        assertEquals(before, server.requestCount)
        // Forced run ignores the scheduled time and completes.
        respondHappy(3)
        client().runPending(force = true)
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
    }

    @Test
    fun `etag header is read case-insensitively`() {
        val job = enqueuePayload(client())
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().addHeader("etag", "lower-case-etag"))
        server.enqueue(MockResponse().setBody("{}"))
        client().runPending()
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
        assertEquals("lower-case-etag", store.load(job.jobId)?.parts?.single()?.etag)
        // And the recorded etag reaches the finalize body.
        val finalize = (0 until server.requestCount).map {
            server.takeRequest(1, TimeUnit.SECONDS)!!
        }.last { it.path == "/api/v1/captures/srv-1/finalize" }
        assertTrue(finalize.body.readUtf8().contains("lower-case-etag"))
    }

    @Test
    fun `expired signed url refreshes upload urls`() {
        val job = enqueuePayload(client())
        server.enqueue(MockResponse().setBody("""{"id":"srv-1"}"""))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(403).setBody("expired"))
        server.enqueue(
            MockResponse().setBody(
                """{"assetId":"a","parts":[{"partNumber":1,"url":"${server.url("/p1b")}"}],"completedParts":[]}""",
            ),
        )
        server.enqueue(MockResponse().addHeader("ETag", "e1"))
        server.enqueue(MockResponse().setBody("{}"))
        client().runPending()
        assertEquals(UploadStatus.COMPLETED, store.load(job.jobId)?.status)
        val requests = (0 until server.requestCount).map {
            server.takeRequest(1, TimeUnit.SECONDS)!!
        }
        assertEquals(
            2,
            requests.count { it.path == "/api/v1/captures/srv-1/uploads" },
        )
    }

    @Test
    fun `sync config rejects non https`() {
        assertTrue(SyncConfig.parse("http://server") is SyncConfig.Unavailable)
        assertTrue(
            SyncConfig.parse("http://server", allowCleartext = true) is SyncConfig.Available,
        )
        assertTrue(SyncConfig.parse("") is SyncConfig.Unavailable)
        assertTrue(SyncConfig.parse("https://api.example.com") is SyncConfig.Available)
    }

    private companion object {
        const val PART_SIZE = 50L
    }
}
