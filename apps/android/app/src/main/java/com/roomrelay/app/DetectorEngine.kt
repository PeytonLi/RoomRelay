package com.roomrelay.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.RectF
import android.media.Image
import com.google.ar.core.Frame
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.ErrorListener
import com.google.mediapipe.tasks.core.OutputHandler
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetector
import com.google.mediapipe.tasks.vision.objectdetector.ObjectDetectorResult
import com.roomrelay.app.core.association.CandidateTrack
import com.roomrelay.app.core.association.CandidateTracker
import com.roomrelay.app.core.association.DetectionBox
import com.roomrelay.app.core.association.TrackState
import com.roomrelay.app.core.inference.BoxPx
import com.roomrelay.app.core.inference.FrameGate
import com.roomrelay.app.core.inference.GateResult
import com.roomrelay.app.core.inference.InferenceTelemetry
import com.roomrelay.app.core.inference.RoomRelayCategory
import com.roomrelay.app.core.inference.ThermalPolicy
import com.roomrelay.app.core.inference.ThermalStatus
import com.roomrelay.app.core.inference.YuvImage
import com.roomrelay.app.core.inference.YuvToArgb
import com.roomrelay.app.core.inference.categoryFromCocoLabel
import com.roomrelay.app.core.inference.mapBoxToImagePixels
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal const val DETECTOR_MODEL_ID = "efficientdet_lite0:int8:1"
internal const val DETECTOR_MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite"
internal const val DETECTOR_MODEL_SHA256 =
    "0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb"
private const val MODEL_ASSET_PATH = "efficientdet_lite0.tflite"

/** A candidate box in sensor-image pixel space (pre transformCoordinates2d). */
internal data class CandidateImageBox(
    val trackId: Long,
    val category: RoomRelayCategory?,
    val cocoLabel: String,
    val score: Float,
    val box: BoxPx,
    val ambiguous: Boolean,
)

/** A track's box expressed in display-rotated view pixels, ready for overlay. */
internal data class OverlayBox(
    val trackId: Long,
    val category: RoomRelayCategory?,
    val cocoLabel: String,
    val score: Float,
    val viewRect: RectF,
    val ambiguous: Boolean,
)

internal data class DetectFrameResult(
    val tracks: List<CandidateTrack>,
    /** Candidate boxes in upright bitmap pixel space. */
    val bitmapBoxes: List<Pair<CandidateTrack, BoxPx>>,
    /** Candidate boxes mapped back to sensor-image pixel space. */
    val imageBoxes: List<Pair<CandidateTrack, BoxPx>>,
    val imageWidth: Int,
    val imageHeight: Int,
    val scale: Float,
    val rotationDeg: Int,
    val frameTimeNs: Long,
)

/**
 * Owns the MediaPipe ObjectDetector, the frame gate, and the association
 * tracker. The GL thread copies YUV planes out of acquireCameraImage (closed
 * immediately); a single inference executor converts to an upright bitmap and
 * calls detectAsync.
 */
internal class DetectorEngine(
    private val context: Context,
    val telemetry: InferenceTelemetry = InferenceTelemetry(),
    private val sensorOrientation: () -> Int,
    private val displayRotationDeg: () -> Int,
) {
    private val executor = Executors.newSingleThreadExecutor()
    private val gate = FrameGate(ThermalPolicy.NORMAL_INTERVAL_MS * 1_000_000L)
    val tracker = CandidateTracker()

    @Volatile
    private var detector: ObjectDetector? = null

    @Volatile
    var detectorError: String? = null
        private set

    @Volatile
    private var submittedNs = 0L

    /** Last timestamp handed to detectAsync; submissions must increase. */
    private var lastSubmittedTsMs = Long.MIN_VALUE

    private val closed = AtomicBoolean(false)

    @Volatile
    var onResult: ((DetectFrameResult) -> Unit)? = null

    @Volatile
    private var pendingFrame: PendingFrame? = null

    // Reused across frames; safe because the gate is single-flight and the
    // executor is single-threaded.
    private var argbReuse: com.roomrelay.app.core.inference.ArgbImage? = null
    private var bitmap: Bitmap? = null

    private class PendingFrame(
        val image: YuvImage,
        val frameTimeNs: Long,
        val imageWidth: Int,
        val imageHeight: Int,
    )

    /**
     * Lazily builds the detector. Failure is recorded once; detection stays
     * unavailable but manual entry keeps working.
     */
    private fun ensureDetector(): ObjectDetector? {
        detector?.let { return it }
        if (detectorError != null || closed.get()) return null
        return try {
            val options = ObjectDetector.ObjectDetectorOptions.builder()
                .setBaseOptions(
                    BaseOptions.builder().setModelAssetPath(MODEL_ASSET_PATH).build(),
                )
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setScoreThreshold(0.5f)
                .setMaxResults(10)
                .setResultListener(OutputHandler.ResultListener { result, input ->
                    onDetectorResult(result)
                })
                .setErrorListener(ErrorListener { error ->
                    telemetry.recordInferenceError()
                    inFlight = null
                    gate.release()
                })
                .build()
            ObjectDetector.createFromOptions(context, options).also { detector = it }
        } catch (exception: Exception) {
            detectorError = "Detection unavailable (${exception.javaClass.simpleName}). " +
                "You can still enter items manually."
            null
        }
    }

    fun setThermalStatus(status: ThermalStatus, nowNs: Long) {
        telemetry.onThermalStatus(status.name, nowNs)
        val interval = ThermalPolicy.minIntervalMs(status)
        if (interval == null) {
            gate.paused = true
        } else {
            gate.paused = false
            gate.minIntervalOverrideNs = interval * 1_000_000L
        }
    }

    fun pauseAssociation() {
        tracker.pause()
    }

    fun resumeAssociation() {
        tracker.resume()
    }

    /**
     * Called from the GL thread once per draw. Gate decides whether this frame
     * is submitted; the camera image is copied and closed immediately.
     */
    fun onGlFrame(frame: Frame, nowNs: Long) {
        if (tracker.paused || closed.get()) return
        val timeoutsBefore = gate.timeoutCount
        val result = gate.tryAcquire(nowNs)
        telemetry.recordGate(result)
        if (gate.timeoutCount != timeoutsBefore) telemetry.recordInferenceTimeout()
        if (result != GateResult.SUBMITTED) return
        val image = try {
            frame.acquireCameraImage()
        } catch (exception: NotYetAvailableException) {
            telemetry.recordCameraImageNotYetAvailable()
            gate.release()
            return
        } catch (exception: Exception) {
            telemetry.recordCameraImageError(exception.javaClass.simpleName)
            gate.release()
            return
        }
        try {
            image.use { yuv ->
                pendingFrame = PendingFrame(
                    image = copyPlanes(yuv),
                    frameTimeNs = frame.timestamp,
                    imageWidth = yuv.width,
                    imageHeight = yuv.height,
                )
            }
        } catch (exception: Exception) {
            telemetry.recordCameraImageError(exception.javaClass.simpleName)
            pendingFrame = null
            gate.release()
            return
        }
        val pending = pendingFrame ?: run {
            gate.release()
            return
        }
        executor.execute { preprocessAndDetect(pending) }
    }

    private fun preprocessAndDetect(pending: PendingFrame) {
        if (closed.get()) {
            gate.release()
            return
        }
        val startNs = System.nanoTime()
        val rotation = com.roomrelay.app.core.inference.rotationDegrees(
            sensorOrientation(),
            displayRotationDeg(),
        )
        val converted = YuvToArgb.convert(
            pending.image,
            rotation,
            reuse = argbReuse,
        )
        argbReuse = converted.image
        val bitmap = bitmap?.takeIf {
            it.width == converted.image.width && it.height == converted.image.height
        } ?: Bitmap.createBitmap(
            converted.image.width,
            converted.image.height,
            Bitmap.Config.ARGB_8888,
        ).also { bitmap = it }
        bitmap.setPixels(
            converted.image.pixels, 0, converted.image.width,
            0, 0, converted.image.width, converted.image.height,
        )
        telemetry.recordPreprocess((System.nanoTime() - startNs) / 1_000_000.0)
        val detector = ensureDetector()
        if (detector == null) {
            gate.release()
            return
        }
        // Timestamps handed to detectAsync must be strictly increasing.
        val tsMs = pending.frameTimeNs / 1_000_000L
        if (tsMs <= lastSubmittedTsMs) {
            telemetry.recordSkippedStaleTimestamp()
            gate.release()
            return
        }
        submittedNs = System.nanoTime()
        lastSubmittedTsMs = tsMs
        inFlight = PendingResult(
            tsMs = tsMs,
            imageWidth = pending.imageWidth,
            imageHeight = pending.imageHeight,
            scale = converted.scale,
            rotationDeg = rotation,
            frameTimeNs = pending.frameTimeNs,
            submitNs = submittedNs,
        )
        try {
            detector.detectAsync(BitmapImageBuilder(bitmap).build(), tsMs)
        } catch (exception: Exception) {
            telemetry.recordInferenceError()
            inFlight = null
            gate.release()
        }
    }

    private class PendingResult(
        val tsMs: Long,
        val imageWidth: Int,
        val imageHeight: Int,
        val scale: Float,
        val rotationDeg: Int,
        val frameTimeNs: Long,
        val submitNs: Long,
    )

    /** Single-flight: at most one submission is awaiting a result. */
    @Volatile
    private var inFlight: PendingResult? = null

    private fun onDetectorResult(result: ObjectDetectorResult) {
        val nowNs = System.nanoTime()
        val pending = inFlight
        // A result from a submission the watchdog already timed out does not
        // match the current in-flight frame and must be ignored.
        if (pending == null || pending.tsMs != result.timestampMs()) return
        inFlight = null
        gate.release()
        telemetry.recordResult(nowNs - pending.submitNs, nowNs)
        val detections = result.detections().mapNotNull { detection ->
            val label = detection.categories().firstOrNull()?.categoryName() ?: return@mapNotNull null
            DetectionBox(
                cocoLabel = label,
                score = detection.categories().first().score(),
                box = BoxPx(
                    detection.boundingBox().left,
                    detection.boundingBox().top,
                    detection.boundingBox().right,
                    detection.boundingBox().bottom,
                ),
            )
        }
        telemetry.recordDetections(detections.map { it.cocoLabel })
        val tracks = tracker.onDetections(detections, nowNs)
        telemetry.recordCandidates(
            tracks.filter { it.state != TrackState.TENTATIVE }
                .mapNotNull { categoryFromCocoLabel(it.cocoLabel) },
        )
        val promoted = tracks.filter { it.state == TrackState.STABLE || it.state == TrackState.AMBIGUOUS }
        val imageBoxes = promoted.map { track ->
            track to mapBoxToImagePixels(
                track.box,
                pending.rotationDeg,
                pending.imageWidth,
                pending.imageHeight,
                pending.scale,
            )
        }
        onResult?.invoke(
            DetectFrameResult(
                tracks = tracks,
                bitmapBoxes = promoted.map { it to it.box },
                imageBoxes = imageBoxes,
                imageWidth = pending.imageWidth,
                imageHeight = pending.imageHeight,
                scale = pending.scale,
                rotationDeg = pending.rotationDeg,
                frameTimeNs = pending.frameTimeNs,
            ),
        )
    }

    private fun copyPlanes(image: Image): YuvImage {
        val yPlane = image.planes[0]
        val uPlane = image.planes[1]
        val vPlane = image.planes[2]
        return YuvImage(
            width = image.width,
            height = image.height,
            yPlane = copyPlane(yPlane.buffer, yPlane.rowStride, image.height),
            uPlane = copyPlane(uPlane.buffer, uPlane.rowStride, image.height / 2),
            vPlane = copyPlane(vPlane.buffer, vPlane.rowStride, image.height / 2),
            yRowStride = yPlane.rowStride,
            uvRowStride = uPlane.rowStride,
            uvPixelStride = uPlane.pixelStride,
        )
    }

    private fun copyPlane(buffer: ByteBuffer, rowStride: Int, rows: Int): ByteArray {
        val size = buffer.remaining().coerceAtMost(rowStride * rows)
        val copy = ByteArray(size)
        buffer.get(copy, 0, size)
        return copy
    }

    fun close() {
        if (closed.compareAndSet(false, true)) {
            executor.shutdown()
            try {
                detector?.close()
            } catch (_: Exception) {
            }
            detector = null
        }
    }
}
