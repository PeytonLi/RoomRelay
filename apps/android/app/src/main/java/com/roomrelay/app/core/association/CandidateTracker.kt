package com.roomrelay.app.core.association

import com.roomrelay.app.core.inference.BoxPx
import com.roomrelay.app.core.inference.iou

data class DetectionBox(
    val cocoLabel: String,
    val score: Float,
    val box: BoxPx,
)

enum class TrackState {
    TENTATIVE,
    STABLE,
    AMBIGUOUS,
}

data class CandidateTrack(
    val id: Long,
    val cocoLabel: String,
    val box: BoxPx,
    val score: Float,
    val state: TrackState,
    val hits: Int,
    val misses: Int,
    val lastSeenNs: Long,
)

/**
 * 2D association across inference results. Matches detections to tracks by
 * same COCO label and IoU >= [iouThreshold]. A track promotes TENTATIVE ->
 * STABLE after [stableAfterHits] hits, and drops after [maxMisses] consecutive
 * misses or [unseenTimeoutNs] unseen. STABLE tracks stay STABLE until dropped.
 *
 * Ambiguity is never auto-merged: a detection overlapping two tracks within
 * [ambiguityIoUWindow] of each other, or two detections claiming one track,
 * marks the track AMBIGUOUS instead of updating it.
 *
 * pause() freezes tracking (no updates, nothing promoted/dropped). resume()
 * clears all tracks because boxes are not comparable across a tracking break.
 */
class CandidateTracker(
    private val iouThreshold: Float = 0.3f,
    private val stableAfterHits: Int = 3,
    private val maxMisses: Int = 5,
    private val unseenTimeoutNs: Long = 1_500_000_000L,
    private val ambiguityIoUWindow: Float = 0.1f,
    private val clock: () -> Long = { System.nanoTime() },
) {
    private class Track(
        val id: Long,
        var cocoLabel: String,
        var box: BoxPx,
        var score: Float,
        var state: TrackState,
        var hits: Int,
        var misses: Int,
        var lastSeenNs: Long,
    )

    private val tracks = mutableListOf<Track>()
    private var nextId = 1L

    @Volatile
    var paused: Boolean = false
        private set

    fun pause() {
        paused = true
    }

    fun resume() {
        tracks.clear()
        paused = false
    }

    fun tracks(): List<CandidateTrack> = synchronized(tracks) {
        tracks.map {
            CandidateTrack(it.id, it.cocoLabel, it.box, it.score, it.state, it.hits, it.misses, it.lastSeenNs)
        }
    }

    /**
     * Feeds one inference result. When paused, returns the current (frozen)
     * track list without updating anything.
     */
    fun onDetections(detections: List<DetectionBox>, nowNs: Long = clock()): List<CandidateTrack> =
        synchronized(tracks) {
            if (paused) return tracks()
            val matchedTracks = mutableSetOf<Track>()
            val matchedDetections = mutableSetOf<Int>()
            // Candidate (detection, track) pairs above the IoU threshold,
            // best-first greedy assignment.
            val candidates = detections.flatMapIndexed { detIndex, det ->
                tracks.filter { it.cocoLabel == det.cocoLabel }
                    .map { track -> Triple(detIndex, track, iou(det.box, track.box)) }
                    .filter { it.third >= iouThreshold }
            }.sortedByDescending { it.third }

            for ((detIndex, track, overlap) in candidates) {
                if (detIndex in matchedDetections) continue
                // Ambiguity: this detection also overlaps another unmatched
                // track within the window, or this track is also claimed by
                // another unmatched detection within the window.
                val rivalTrack = candidates.any { (d, t, o) ->
                    d == detIndex && t !== track && t !in matchedTracks &&
                        overlap - o <= ambiguityIoUWindow
                }
                val rivalDetection = candidates.any { (d, t, o) ->
                    t === track && d != detIndex && d !in matchedDetections &&
                        overlap - o <= ambiguityIoUWindow
                }
                if (rivalTrack || rivalDetection) {
                    // Consume the detection without merging; the box stays
                    // where the user last saw a single item.
                    track.state = TrackState.AMBIGUOUS
                    track.lastSeenNs = nowNs
                    matchedTracks += track
                    matchedDetections += detIndex
                    continue
                }
                val det = detections[detIndex]
                track.box = det.box
                track.score = det.score
                track.hits += 1
                track.misses = 0
                track.lastSeenNs = nowNs
                if (track.state == TrackState.TENTATIVE && track.hits >= stableAfterHits) {
                    track.state = TrackState.STABLE
                }
                matchedTracks += track
                matchedDetections += detIndex
            }

            tracks.filter { it !in matchedTracks }.forEach { it.misses += 1 }
            tracks.removeAll {
                it.misses > maxMisses || nowNs - it.lastSeenNs > unseenTimeoutNs
            }
            detections.forEachIndexed { index, det ->
                if (index !in matchedDetections) {
                    tracks += Track(
                        id = nextId++,
                        cocoLabel = det.cocoLabel,
                        box = det.box,
                        score = det.score,
                        state = TrackState.TENTATIVE,
                        hits = 1,
                        misses = 0,
                        lastSeenNs = nowNs,
                    )
                }
            }
            tracks()
        }
}
