package com.roomrelay.app.core.association

import com.roomrelay.app.core.inference.BoxPx
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CandidateTrackerTest {

    private fun det(label: String, l: Float, t: Float, r: Float, b: Float, score: Float = 0.9f) =
        DetectionBox(label, score, BoxPx(l, t, r, b))

    private val chairBox = det("chair", 0f, 0f, 100f, 100f)

    @Test
    fun `tentative to stable after three hits`() {
        val tracker = CandidateTracker()
        var now = 0L
        tracker.onDetections(listOf(chairBox), now)
        var tracks = tracker.tracks()
        assertEquals(TrackState.TENTATIVE, tracks.single().state)

        now += 200_000_000L
        tracker.onDetections(listOf(chairBox), now)
        tracks = tracker.tracks()
        assertEquals(2, tracks.single().hits)
        assertEquals(TrackState.TENTATIVE, tracks.single().state)

        now += 200_000_000L
        tracker.onDetections(listOf(chairBox), now)
        tracks = tracker.tracks()
        assertEquals(TrackState.STABLE, tracks.single().state)
    }

    @Test
    fun `track drops after consecutive misses`() {
        val tracker = CandidateTracker(maxMisses = 5)
        var now = 0L
        tracker.onDetections(listOf(chairBox), now)
        repeat(5) {
            now += 100_000_000L
            tracker.onDetections(emptyList(), now)
        }
        assertEquals(1, tracker.tracks().size)
        now += 100_000_000L
        tracker.onDetections(emptyList(), now)
        assertTrue(tracker.tracks().isEmpty())
    }

    @Test
    fun `track drops after unseen timeout`() {
        val tracker = CandidateTracker()
        var now = 0L
        tracker.onDetections(listOf(chairBox), now)
        now += 1_600_000_000L
        tracker.onDetections(emptyList(), now)
        assertTrue(tracker.tracks().isEmpty())
    }

    @Test
    fun `two similar chairs become ambiguous not merged`() {
        val tracker = CandidateTracker()
        var now = 0L
        // Two chair tracks from separate detections.
        tracker.onDetections(
            listOf(det("chair", 0f, 0f, 100f, 100f), det("chair", 60f, 0f, 160f, 100f)),
            now,
        )
        assertEquals(2, tracker.tracks().size)
        // One detection overlapping both tracks equally (IoU ~0.54 each) ->
        // ambiguity, not merge.
        now += 100_000_000L
        tracker.onDetections(listOf(det("chair", 30f, 0f, 130f, 100f)), now)
        val tracks = tracker.tracks()
        assertEquals(2, tracks.size)
        assertTrue(tracks.any { it.state == TrackState.AMBIGUOUS })
    }

    @Test
    fun `different labels never match`() {
        val tracker = CandidateTracker()
        var now = 0L
        tracker.onDetections(listOf(chairBox), now)
        now += 100_000_000L
        tracker.onDetections(listOf(det("couch", 0f, 0f, 100f, 100f)), now)
        assertEquals(2, tracker.tracks().size)
    }

    @Test
    fun `pause freezes tracks`() {
        val tracker = CandidateTracker()
        tracker.onDetections(listOf(chairBox), 0L)
        tracker.pause()
        val tracks = tracker.onDetections(emptyList(), 1_000_000_000L)
        assertEquals(1, tracks.size)
        assertEquals(0, tracks.single().misses)
        tracker.onDetections(
            listOf(det("chair", 500f, 500f, 600f, 600f)),
            2_000_000_000L,
        )
        assertEquals(1, tracker.tracks().size)
    }

    @Test
    fun `resume clears all tracks`() {
        val tracker = CandidateTracker()
        tracker.onDetections(listOf(chairBox), 0L)
        tracker.pause()
        tracker.resume()
        assertTrue(tracker.tracks().isEmpty())
    }
}
