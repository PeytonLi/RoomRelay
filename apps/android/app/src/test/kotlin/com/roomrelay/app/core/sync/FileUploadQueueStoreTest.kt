package com.roomrelay.app.core.sync

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class FileUploadQueueStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun store() = FileUploadQueueStore(tmp.root)

    private fun job(id: String, status: UploadStatus = UploadStatus.PENDING) = UploadJob(
        jobId = id,
        idempotencyKey = "key-$id",
        clientCaptureId = "cap-$id",
        kind = "ITEM",
        consentVersion = "v1",
        payloadSha256 = "sha",
        payloadBytes = 100L,
        partSizeBytes = 50L,
    ).copy(status = status)

    @Test
    fun `persist and reload`() {
        val store = store()
        store.save(job("j1"))
        val loaded = store.load("j1")
        assertEquals("j1", loaded?.jobId)
        assertEquals("cap-j1", loaded?.clientCaptureId)
        assertEquals(1, store.list().size)
    }

    @Test
    fun `running on disk loads as pending`() {
        val store = store()
        store.save(job("j2", UploadStatus.RUNNING))
        assertEquals(UploadStatus.PENDING, store.load("j2")?.status)
    }

    @Test
    fun `corrupt job file skipped and reported`() {
        val store = store()
        store.save(job("good"))
        val jobsDir = File(tmp.root, "jobs")
        File(jobsDir, "broken.json").writeText("{ not json !!!")
        val jobs = store.list()
        assertEquals(1, jobs.size)
        assertEquals("good", jobs.single().jobId)
        assertEquals(1, store.corruptFiles().size)
    }

    @Test
    fun `enqueue dedupes by clientCaptureId`() {
        val store = store()
        val capture = com.roomrelay.app.core.capture.CaptureSession(
            clientCaptureId = "cap-dedupe",
            kind = com.roomrelay.app.core.capture.CaptureKind.ITEM,
            consentVersion = "v1",
            createdAtUtc = "2026-01-01T00:00:00Z",
            device = com.roomrelay.app.core.capture.CaptureDevice(
                "m", "m", 34, "0.2.0", "1.56.0", "model",
            ),
            frameId = "arcore-session:x",
        )
        val client = UploadClient(
            http = okhttp3.OkHttpClient(),
            store = store,
            auth = UnavailableAuthTokenProvider(),
            configProvider = { SyncConfig.Unavailable("none") },
        )
        val first = client.enqueue(capture, byteArrayOf(1, 2, 3))
        val second = client.enqueue(capture, byteArrayOf(1, 2, 3))
        assertEquals(first.jobId, second.jobId)
        assertEquals(1, store.list().size)
    }
}
