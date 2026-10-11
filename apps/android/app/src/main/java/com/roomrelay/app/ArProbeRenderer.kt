package com.roomrelay.app

import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.os.SystemClock
import android.view.MotionEvent
import android.view.Surface
import com.google.ar.core.Anchor
import com.google.ar.core.Coordinates2d
import com.google.ar.core.DepthPoint
import com.google.ar.core.Frame
import com.google.ar.core.HitResult
import com.google.ar.core.InstantPlacementPoint
import com.google.ar.core.Plane
import com.google.ar.core.Point
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.NotYetAvailableException
import com.google.ar.core.exceptions.SessionPausedException
import com.roomrelay.app.core.HitCandidate
import com.roomrelay.app.core.HitKind
import com.roomrelay.app.core.HitSelectionPolicy
import com.roomrelay.app.core.Vec3
import com.roomrelay.app.core.distanceMeters
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

internal data class MeasureSnapshot(
    val status: String = "Waiting for camera",
    val trackingState: String = "STOPPED",
    val failureReason: String = "",
    val planesHorizontal: Int = 0,
    val planesVertical: Int = 0,
    val depthMode: String = "DISABLED",
    val depthAvailable: Boolean = false,
    val fps: Int = 0,
    val distanceMeters: Double? = null,
    val firstHitType: String? = null,
    val secondHitType: String? = null,
    val hasBothAnchors: Boolean = false,
    val anchorTracking: List<String> = emptyList(),
    val message: String = "",
)

internal class ArProbeRenderer(
    private val sessionProvider: () -> Session?,
    private val depthEnabled: () -> Boolean,
    private val displayRotation: () -> Int,
    private val onFrame: (MeasureSnapshot, Long) -> Unit,
    private val onStatus: (String) -> Unit,
) : GLSurfaceView.Renderer {
    private val pendingTaps = ConcurrentLinkedQueue<MotionEvent>()
    private val ndcCoordinates = floatBufferOf(
        -1f, -1f,
        1f, -1f,
        -1f, 1f,
        1f, 1f,
    )
    private val textureCoordinates = floatBufferOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f)
    private val projection = FloatArray(16)
    private val view = FloatArray(16)
    private val viewProjection = FloatArray(16)
    private var cameraTexture = 0
    private var backgroundProgram = 0
    private var measurementProgram = 0
    private var backgroundPosition = -1
    private var backgroundTexCoord = -1
    private var backgroundTextureUniform = -1
    private var measurementPosition = -1
    private var measurementMvp = -1
    private var measurementColor = -1
    private var measurementPointSize = -1
    private var viewportWidth = 0
    private var viewportHeight = 0
    private var lastRotation = Surface.ROTATION_0
    private var boundSession: Session? = null
    private var anchorA: Anchor? = null
    private var anchorB: Anchor? = null
    private var hitTypeA: String? = null
    private var hitTypeB: String? = null
    @Volatile
    private var statusMessage = ""
    private var displayGeometryDirty = true
    private var textureCoordinatesDirty = true
    private var lastViewportWidth = 0
    private var lastViewportHeight = 0
    private var lastTimestamp = 0L
    private var fpsWindowStartNs = 0L
    private var fpsFrameCount = 0
    private var fps = 0
    private var latestSnapshot = MeasureSnapshot()

    fun queueTap(event: MotionEvent) {
        pendingTaps.offer(MotionEvent.obtain(event))
    }

    fun discardPendingTaps() {
        while (true) {
            val tap = pendingTaps.poll() ?: break
            tap.recycle()
        }
    }

    fun resetPoints() {
        statusMessage = "Points reset"
        resetPointsOnGlThread = true
    }

    @Volatile
    private var resetPointsOnGlThread = false

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        try {
            GLES20.glClearColor(0f, 0f, 0f, 1f)
            cameraTexture = createCameraTexture()
            backgroundProgram = createProgram(BACKGROUND_VERTEX_SHADER, BACKGROUND_FRAGMENT_SHADER)
            backgroundPosition = GLES20.glGetAttribLocation(backgroundProgram, "a_Position")
            backgroundTexCoord = GLES20.glGetAttribLocation(backgroundProgram, "a_TexCoord")
            backgroundTextureUniform = GLES20.glGetUniformLocation(backgroundProgram, "sTexture")
            measurementProgram = createProgram(MEASUREMENT_VERTEX_SHADER, MEASUREMENT_FRAGMENT_SHADER)
            measurementPosition = GLES20.glGetAttribLocation(measurementProgram, "a_Position")
            measurementMvp = GLES20.glGetUniformLocation(measurementProgram, "u_Mvp")
            measurementColor = GLES20.glGetUniformLocation(measurementProgram, "u_Color")
            measurementPointSize = GLES20.glGetUniformLocation(measurementProgram, "u_PointSize")
            boundSession = null
        } catch (exception: Exception) {
            onStatus("Camera renderer could not start (${exception.javaClass.simpleName})")
        }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        viewportWidth = width
        viewportHeight = height
        displayGeometryDirty = true
        GLES20.glViewport(0, 0, width, height)
        try {
            updateDisplayGeometry(sessionProvider())
        } catch (exception: Exception) {
            onStatus("Display geometry update failed (${exception.javaClass.simpleName})")
        }
    }

    override fun onDrawFrame(gl: GL10?) {
        try {
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            val session = sessionProvider() ?: return
            ensureCameraTexture(session)
            updateDisplayGeometry(session)
            val frame = try {
                session.update()
            } catch (exception: CameraNotAvailableException) {
                onStatus("Camera is unavailable (${exception.javaClass.simpleName})")
                return
            } catch (exception: SessionPausedException) {
                onStatus("Camera session is paused (${exception.javaClass.simpleName})")
                return
            }
            if (frame.timestamp == 0L) return

            drawCameraBackground(frame)
            processTap(frame)
            val snapshot = collectFrame(session, frame)
            drawMeasurements(frame)
            if (frame.timestamp != lastTimestamp) {
                lastTimestamp = frame.timestamp
                val nowNs = SystemClock.elapsedRealtimeNanos()
                updateFps(nowNs)
                latestSnapshot = snapshot.copy(fps = fps, message = statusMessage)
                onFrame(latestSnapshot, nowNs)
            }
        } catch (exception: Exception) {
            onStatus("Camera frame failed (${exception.javaClass.simpleName})")
        }
    }

    private fun ensureCameraTexture(session: Session) {
        if (boundSession !== session && cameraTexture != 0) {
            session.setCameraTextureName(cameraTexture)
            boundSession = session
            displayGeometryDirty = true
        }
    }

    private fun updateDisplayGeometry(session: Session?) {
        if (session == null || viewportWidth == 0 || viewportHeight == 0) return
        val rotation = displayRotation()
        if (displayGeometryDirty ||
            rotation != lastRotation ||
            viewportWidth != lastViewportWidth ||
            viewportHeight != lastViewportHeight
        ) {
            session.setDisplayGeometry(rotation, viewportWidth, viewportHeight)
            lastRotation = rotation
            lastViewportWidth = viewportWidth
            lastViewportHeight = viewportHeight
            displayGeometryDirty = false
            textureCoordinatesDirty = true
        }
    }

    private fun drawCameraBackground(frame: Frame) {
        if (backgroundProgram == 0) return
        if (textureCoordinatesDirty || frame.hasDisplayGeometryChanged()) {
            ndcCoordinates.position(0)
            textureCoordinates.position(0)
            frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                ndcCoordinates,
                Coordinates2d.TEXTURE_NORMALIZED,
                textureCoordinates,
            )
            ndcCoordinates.position(0)
            textureCoordinates.position(0)
            textureCoordinatesDirty = false
        }
        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glUseProgram(backgroundProgram)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, cameraTexture)
        GLES20.glUniform1i(backgroundTextureUniform, 0)
        GLES20.glEnableVertexAttribArray(backgroundPosition)
        GLES20.glVertexAttribPointer(backgroundPosition, 2, GLES20.GL_FLOAT, false, 0, ndcCoordinates)
        GLES20.glEnableVertexAttribArray(backgroundTexCoord)
        GLES20.glVertexAttribPointer(backgroundTexCoord, 2, GLES20.GL_FLOAT, false, 0, textureCoordinates)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(backgroundPosition)
        GLES20.glDisableVertexAttribArray(backgroundTexCoord)
    }

    private fun collectFrame(session: Session, frame: Frame): MeasureSnapshot {
        val camera = frame.camera
        val tracking = camera.trackingState
        val failure = if (tracking == TrackingState.TRACKING) "" else camera.trackingFailureReason.name
        var horizontal = 0
        var vertical = 0
        session.getAllTrackables(Plane::class.java)
            .asSequence()
            .filter { it.trackingState == TrackingState.TRACKING && it.subsumedBy == null }
            .forEach { plane ->
                when (plane.type) {
                    Plane.Type.HORIZONTAL_UPWARD_FACING,
                    Plane.Type.HORIZONTAL_DOWNWARD_FACING -> horizontal += 1
                    Plane.Type.VERTICAL -> vertical += 1
                    else -> Unit
                }
            }

        var depthAttempted = false
        var depthAcquired = false
        var depthWidth: Int? = null
        var depthHeight: Int? = null
        var depthError: String? = null
        if (depthEnabled()) {
            depthAttempted = true
            try {
                frame.acquireDepthImage16Bits().use { image ->
                    depthAcquired = true
                    depthWidth = image.width
                    depthHeight = image.height
                }
            } catch (_: NotYetAvailableException) {
                Unit
            } catch (exception: Exception) {
                depthError = exception.javaClass.simpleName
            }
        }

        onObservation(
            tracking.name,
            failure,
            horizontal,
            vertical,
            depthAttempted,
            depthAcquired,
            depthWidth,
            depthHeight,
            depthError,
        )
        val a = anchorA
        val b = anchorB
        val distance = if (a != null && b != null) {
            val poseA = a.pose
            val poseB = b.pose
            distanceMeters(
                Vec3(poseA.tx().toDouble(), poseA.ty().toDouble(), poseA.tz().toDouble()),
                Vec3(poseB.tx().toDouble(), poseB.ty().toDouble(), poseB.tz().toDouble()),
            )
        } else {
            null
        }
        return MeasureSnapshot(
            status = "AR session active",
            trackingState = tracking.name,
            failureReason = failure,
            planesHorizontal = horizontal,
            planesVertical = vertical,
            depthMode = if (depthEnabled()) "AUTOMATIC" else "DISABLED",
            depthAvailable = depthEnabled(),
            fps = fps,
            distanceMeters = distance,
            firstHitType = hitTypeA,
            secondHitType = hitTypeB,
            hasBothAnchors = a != null && b != null,
            anchorTracking = listOfNotNull(a?.trackingState?.name, b?.trackingState?.name),
            message = statusMessage,
        )
    }

    private fun onObservation(
        trackingState: String,
        failureReason: String,
        horizontal: Int,
        vertical: Int,
        depthAttempted: Boolean,
        depthAcquired: Boolean,
        depthWidth: Int?,
        depthHeight: Int?,
        depthError: String?,
    ) {
        latestObservation = com.roomrelay.app.core.FrameObservation(
            trackingState = trackingState,
            failureReason = failureReason,
            planesHorizontal = horizontal,
            planesVertical = vertical,
            depthAttempted = depthAttempted,
            depthAcquired = depthAcquired,
            depthWidth = depthWidth,
            depthHeight = depthHeight,
            depthErrorClass = depthError,
        )
    }

    private var latestObservation = com.roomrelay.app.core.FrameObservation(
        trackingState = "STOPPED",
        failureReason = "",
        planesHorizontal = 0,
        planesVertical = 0,
        depthAttempted = false,
        depthAcquired = false,
        depthWidth = null,
        depthHeight = null,
        depthErrorClass = null,
    )

    private fun processTap(frame: Frame) {
        if (resetPointsOnGlThread) {
            resetPointsOnGlThread = false
            anchorA?.detach()
            anchorB?.detach()
            anchorA = null
            anchorB = null
            hitTypeA = null
            hitTypeB = null
        }
        val tap = pendingTaps.poll() ?: return
        try {
            if (anchorA != null && anchorB != null) {
                statusMessage = "Save or reset this trial first"
                return
            }
            if (frame.camera.trackingState != TrackingState.TRACKING) {
                statusMessage = "Wait for camera tracking before tapping"
                return
            }
            val candidates = frame.hitTest(tap.x, tap.y).map { hit -> toCandidate(hit) }
            val selected = HitSelectionPolicy.select(candidates)
            if (selected == null) {
                statusMessage = "No usable surface under your tap. Try a plane or textured surface."
                return
            }
            val anchor = selected.hit.createAnchor()
            if (anchorA == null) {
                anchorA = anchor
                hitTypeA = selected.label
                statusMessage = "Point A set. Tap a second point."
            } else {
                anchorB = anchor
                hitTypeB = selected.label
                statusMessage = "Point B set. Enter the tape length and save the trial."
            }
        } catch (exception: Exception) {
            statusMessage = "Could not set measurement point (${exception.javaClass.simpleName})"
        } finally {
            tap.recycle()
        }
    }

    private fun toCandidate(hit: HitResult): ArHitCandidate {
        val trackable = hit.trackable
        return when (trackable) {
            is DepthPoint -> ArHitCandidate(hit, HitKind.DEPTH_POINT, "DEPTH_POINT")
            is Plane -> ArHitCandidate(
                hit,
                HitKind.PLANE,
                "PLANE_${trackable.type.name}",
                isPoseInPlanePolygon = trackable.isPoseInPolygon(hit.hitPose),
            )
            is Point -> ArHitCandidate(
                hit,
                HitKind.POINT,
                "POINT_SURFACE_NORMAL",
                hasEstimatedSurfaceNormal =
                    trackable.orientationMode == Point.OrientationMode.ESTIMATED_SURFACE_NORMAL,
            )
            is InstantPlacementPoint -> ArHitCandidate(hit, HitKind.INSTANT_PLACEMENT_POINT, "INSTANT_PLACEMENT_POINT")
            else -> ArHitCandidate(hit, HitKind.OTHER, HitSelectionPolicy.label(OtherHitCandidate))
        }
    }

    private fun drawMeasurements(frame: Frame) {
        if (measurementProgram == 0) return
        frame.camera.getProjectionMatrix(projection, 0, 0.05f, 100f)
        frame.camera.getViewMatrix(view, 0)
        Matrix.multiplyMM(viewProjection, 0, projection, 0, view, 0)
        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glUseProgram(measurementProgram)
        GLES20.glUniformMatrix4fv(measurementMvp, 1, false, viewProjection, 0)
        val positions = floatArrayOf(
            anchorA?.pose?.tx() ?: 0f,
            anchorA?.pose?.ty() ?: 0f,
            anchorA?.pose?.tz() ?: 0f,
            anchorB?.pose?.tx() ?: 0f,
            anchorB?.pose?.ty() ?: 0f,
            anchorB?.pose?.tz() ?: 0f,
        )
        if (anchorA != null && anchorB != null) {
            GLES20.glUniform4f(measurementColor, 0.2f, 0.85f, 1f, 1f)
            GLES20.glUniform1f(measurementPointSize, 3f)
            GLES20.glEnableVertexAttribArray(measurementPosition)
            GLES20.glVertexAttribPointer(measurementPosition, 3, GLES20.GL_FLOAT, false, 0, floatBufferOf(*positions))
            GLES20.glDrawArrays(GLES20.GL_LINES, 0, 2)
            GLES20.glDisableVertexAttribArray(measurementPosition)
        }
        val pointPositions = when {
            anchorA != null && anchorB != null -> positions
            anchorA != null -> positions.copyOfRange(0, 3)
            else -> return
        }
        GLES20.glUniform4f(measurementColor, 1f, 0.78f, 0.2f, 1f)
        GLES20.glUniform1f(measurementPointSize, 18f)
        GLES20.glEnableVertexAttribArray(measurementPosition)
        GLES20.glVertexAttribPointer(
            measurementPosition,
            3,
            GLES20.GL_FLOAT,
            false,
            0,
            floatBufferOf(*pointPositions),
        )
        GLES20.glDrawArrays(GLES20.GL_POINTS, 0, pointPositions.size / 3)
        GLES20.glDisableVertexAttribArray(measurementPosition)
    }

    private fun updateFps(nowNs: Long) {
        if (fpsWindowStartNs == 0L) fpsWindowStartNs = nowNs
        fpsFrameCount += 1
        val elapsed = nowNs - fpsWindowStartNs
        if (elapsed >= 1_000_000_000L) {
            fps = (fpsFrameCount * 1_000_000_000L / elapsed).toInt()
            fpsFrameCount = 0
            fpsWindowStartNs = nowNs
        }
    }

    fun drainObservation(): com.roomrelay.app.core.FrameObservation = latestObservation

    fun detachAnchors() {
        resetPoints()
    }

    fun snapshot(): MeasureSnapshot = latestSnapshot

    fun publishStatus(status: String) {
        statusMessage = status
    }

    private fun createCameraTexture(): Int {
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textures[0])
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MIN_FILTER,
            GLES20.GL_LINEAR,
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MAG_FILTER,
            GLES20.GL_LINEAR,
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_S,
            GLES20.GL_CLAMP_TO_EDGE,
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_T,
            GLES20.GL_CLAMP_TO_EDGE,
        )
        return textures[0]
    }

    private fun createProgram(vertexSource: String, fragmentSource: String): Int {
        val vertex = compileShader(GLES20.GL_VERTEX_SHADER, vertexSource)
        val fragment = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
        return GLES20.glCreateProgram().also { program ->
            GLES20.glAttachShader(program, vertex)
            GLES20.glAttachShader(program, fragment)
            GLES20.glLinkProgram(program)
            val status = IntArray(1)
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
            if (status[0] == 0) {
                val message = GLES20.glGetProgramInfoLog(program)
                GLES20.glDeleteProgram(program)
                throw IllegalStateException("Shader program link failed: $message")
            }
            GLES20.glDeleteShader(vertex)
            GLES20.glDeleteShader(fragment)
        }
    }

    private fun compileShader(type: Int, source: String): Int =
        GLES20.glCreateShader(type).also { shader ->
            GLES20.glShaderSource(shader, source)
            GLES20.glCompileShader(shader)
            val status = IntArray(1)
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
            if (status[0] == 0) {
                val message = GLES20.glGetShaderInfoLog(shader)
                GLES20.glDeleteShader(shader)
                throw IllegalStateException("Shader compile failed: $message")
            }
        }

    private data class ArHitCandidate(
        val hit: HitResult,
        override val kind: HitKind,
        val label: String,
        override val isPoseInPlanePolygon: Boolean = false,
        override val hasEstimatedSurfaceNormal: Boolean = false,
    ) : HitCandidate

    private object OtherHitCandidate : HitCandidate {
        override val kind = HitKind.OTHER
        override val isPoseInPlanePolygon = false
        override val hasEstimatedSurfaceNormal = false
    }

    private companion object {
        val BACKGROUND_VERTEX_SHADER = """
            attribute vec4 a_Position;
            attribute vec2 a_TexCoord;
            varying vec2 v_TexCoord;
            void main() {
                gl_Position = a_Position;
                v_TexCoord = a_TexCoord;
            }
        """.trimIndent()

        val BACKGROUND_FRAGMENT_SHADER = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES sTexture;
            varying vec2 v_TexCoord;
            void main() {
                gl_FragColor = texture2D(sTexture, v_TexCoord);
            }
        """.trimIndent()

        val MEASUREMENT_VERTEX_SHADER = """
            attribute vec4 a_Position;
            uniform mat4 u_Mvp;
            uniform float u_PointSize;
            void main() {
                gl_Position = u_Mvp * a_Position;
                gl_PointSize = u_PointSize;
            }
        """.trimIndent()

        val MEASUREMENT_FRAGMENT_SHADER = """
            precision mediump float;
            uniform vec4 u_Color;
            void main() {
                gl_FragColor = u_Color;
            }
        """.trimIndent()

        fun floatBufferOf(vararg values: Float): FloatBuffer =
            ByteBuffer.allocateDirect(values.size * Float.SIZE_BYTES)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
                .apply {
                    put(values)
                    position(0)
                }
    }
}
