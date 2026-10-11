package com.roomrelay.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.MotionEvent
import android.view.Surface
import android.view.WindowManager
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import androidx.core.content.pm.PackageInfoCompat
import androidx.activity.ComponentActivity
import android.opengl.GLSurfaceView
import com.google.ar.core.Anchor
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.roomrelay.app.core.AppInfo
import com.roomrelay.app.core.CameraConfigInfo
import com.roomrelay.app.core.Capabilities
import com.roomrelay.app.core.DetectorModelInfo
import com.roomrelay.app.core.DeviceInfo
import com.roomrelay.app.core.MeasurementTrial
import com.roomrelay.app.core.ProbeReport
import com.roomrelay.app.core.SessionLogger
import com.roomrelay.app.core.Vec3
import com.roomrelay.app.core.association.ConfirmedItemRegistry
import com.roomrelay.app.core.association.MergeDecision
import com.roomrelay.app.core.capture.CaptureAnchor
import com.roomrelay.app.core.capture.CaptureAxis
import com.roomrelay.app.core.capture.CaptureDevice
import com.roomrelay.app.core.capture.CaptureDraftStore
import com.roomrelay.app.core.capture.CaptureKind
import com.roomrelay.app.core.capture.CaptureSession
import com.roomrelay.app.core.capture.CapturedItem
import com.roomrelay.app.core.capture.DetectionEvidence
import com.roomrelay.app.core.capture.DimensionMeasurement
import com.roomrelay.app.core.capture.DimensionSource
import com.roomrelay.app.core.capture.validateForUpload
import com.roomrelay.app.core.computeError
import com.roomrelay.app.core.encodeReport
import com.roomrelay.app.core.inference.RoomRelayCategory
import com.roomrelay.app.core.inference.ThermalStatus
import com.roomrelay.app.core.parseTapeCm
import com.roomrelay.app.core.sync.FileUploadQueueStore
import com.roomrelay.app.core.sync.SyncConfig
import com.roomrelay.app.core.sync.UnavailableAuthTokenProvider
import com.roomrelay.app.core.sync.UploadClient
import com.roomrelay.app.core.sync.UploadJob
import com.roomrelay.app.core.sync.UploadStatus
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.EnumSet
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal data class CapabilitySnapshot(
    val arServicesInstalled: Boolean = false,
    val arServicesVersionName: String? = null,
    val arServicesVersionCode: Long? = null,
    val availability: String = "CHECKING",
    val availabilityPolls: Int = 0,
    val checkingAvailability: Boolean = true,
    val installRequestResult: String? = null,
    val cameraPermission: String = "DENIED",
    val sessionCreated: Boolean = false,
    val sessionErrorClass: String? = null,
    val sessionErrorMessage: String? = null,
    val depthAutomaticSupported: Boolean? = null,
    val rawDepthOnlySupported: Boolean? = null,
    val activeCameraConfig: CameraConfigInfo? = null,
    val cameraConfigs: List<CameraConfigInfo> = emptyList(),
    val configureErrorClass: String? = null,
    val configureErrorMessage: String? = null,
)

internal data class DetectUiState(
    val overlayBoxes: List<OverlayBox> = emptyList(),
    val statusLine: String = "Detection starts when the camera is running.",
    val message: String = "",
    val thermalStatus: String = "NONE",
    val inferencePaused: Boolean = false,
    val trackingState: String = "STOPPED",
    val achievedFps: Double = 0.0,
    val latencyP50Ms: Double? = null,
    val tentativeCount: Int = 0,
    val stableCount: Int = 0,
    val ambiguousCount: Int = 0,
)

/** Merge question shown to the user when association is uncertain. */
internal data class AskState(
    val candidateIds: List<Long>,
    val prompt: String,
)

internal data class ProbeUiState(
    val capability: CapabilitySnapshot = CapabilitySnapshot(),
    val measure: MeasureSnapshot = MeasureSnapshot(),
    val detect: DetectUiState = DetectUiState(),
    val trials: List<MeasurementTrial> = emptyList(),
    val lastSavedPairId: Long? = null,
    val notes: String = "",
    val sessionLog: com.roomrelay.app.core.SessionLog? = null,
    val sessionLogRunning: Boolean = false,
    val sessionElapsedS: Long = 0L,
    val reportFileName: String? = null,
    val reportMessage: String = "",
    val drafts: List<CaptureSession> = emptyList(),
    val uploadJobs: List<UploadJob> = emptyList(),
    val syncBanner: String? = null,
    val ask: AskState? = null,
    val queueMessage: String = "",
)

internal class ProbeController(private val activity: ComponentActivity) {
    private val handler = Handler(Looper.getMainLooper())
    private val sessionLogger = SessionLogger()
    private val mutableState = MutableStateFlow(
        ProbeUiState(
            capability = CapabilitySnapshot(
                cameraPermission = cameraPermissionStatus(),
            ),
        ),
    )
    val state = mutableState.asStateFlow()

    @Volatile
    private var session: Session? = null

    @Volatile
    private var automaticDepthEnabled = false

    private var renderer: ArProbeRenderer
    @Volatile
    private var glView: GLSurfaceView? = null
    private var activityResumed = false
    private var measureVisible = false
    private var detectVisible = false
    private var sessionResumed = false
    private var installRequestPending = false
    private var lastUiPublishNs = 0L
    private var configureErrorClass: String? = null
    private var configureErrorMessage: String? = null

    private val detectorEngine = DetectorEngine(
        context = activity.applicationContext,
        sensorOrientation = ::sensorOrientationDeg,
        displayRotationDeg = { rotationToDegrees(glView?.display?.rotation ?: Surface.ROTATION_0) },
    )
    private val itemRegistry = ConfirmedItemRegistry()
    private val draftStore = CaptureDraftStore(File(activity.filesDir, "drafts"))
    private val uploadStore = FileUploadQueueStore(File(activity.filesDir, "upload-queue"))
    private val authTokenProvider = UnavailableAuthTokenProvider()
    private val uploadClient = UploadClient(
        http = OkHttpClient(),
        store = uploadStore,
        auth = authTokenProvider,
        configProvider = { SyncConfig.parse(BuildConfig.ROOMRELAY_API_BASE_URL) },
    )
    private val syncExecutor = Executors.newSingleThreadExecutor()
    private val itemAnchors = java.util.concurrent.ConcurrentHashMap<String, Anchor>()
    private var lastTrackingState = "STOPPED"
    private var trackingBreaks = 0
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null
    private var pendingConfirm: PendingConfirm? = null

    private class PendingConfirm(
        val trackId: Long,
        val anchor: Anchor,
        val hitType: String,
        val trackingState: String,
        val cocoLabel: String,
        val score: Float,
        val evidence: DetectionEvidence?,
    )

    init {
        renderer = ArProbeRenderer(
            sessionProvider = { session },
            depthEnabled = { automaticDepthEnabled },
            displayRotation = { glView?.display?.rotation ?: Surface.ROTATION_0 },
            onFrame = ::onRendererFrame,
            onStatus = ::onRendererStatus,
        )
        wireDetectorCallbacks()
        registerThermalListener()
        refreshCapabilities()
        mutableState.update {
            it.copy(
                drafts = draftStore.list(),
                uploadJobs = uploadStore.list(),
                syncBanner = syncBannerText(),
            )
        }
        runPendingUploads()
    }

    fun refreshCapabilities() {
        handler.removeCallbacksAndMessages(null)
        refreshArServicesPackage()
        mutableState.update { state ->
            state.copy(
                capability = state.capability.copy(
                    availability = "CHECKING",
                    availabilityPolls = 0,
                    checkingAvailability = true,
                    cameraPermission = cameraPermissionStatus(),
                ),
            )
        }
        pollAvailability()
    }

    fun onCameraPermissionResult(granted: Boolean) {
        updateCapability {
            copy(
                cameraPermission = if (granted) "GRANTED" else "DENIED",
                sessionErrorClass = null,
                sessionErrorMessage = if (granted) null else "Camera permission is required to start AR.",
            )
        }
        if (granted) createSessionIfReady()
    }

    fun openAppSettings() {
        activity.startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                "package:${activity.packageName}".toUri(),
            ),
        )
    }

    fun requestInstall() {
        try {
            val result = ArCoreApk.getInstance().requestInstall(activity, true)
            updateCapability { copy(installRequestResult = result.name) }
            if (result == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequestPending = true
            } else {
                installRequestPending = false
                refreshCapabilities()
            }
        } catch (exception: Exception) {
            updateCapability {
                copy(
                    installRequestResult = exception.javaClass.simpleName,
                    sessionErrorClass = exception.javaClass.simpleName,
                    sessionErrorMessage = "Google Play Services for AR could not be installed or updated (${exception.javaClass.simpleName}).",
                )
            }
        }
    }

    fun onActivityResume() {
        activityResumed = true
        updateCapability { copy(cameraPermission = cameraPermissionStatus()) }
        refreshArServicesPackage()
        if (installRequestPending) {
            completeInstallRequest()
        } else {
            createSessionIfReady()
            syncSessionLifecycle()
        }
    }

    fun onActivityPause() {
        activityResumed = false
        syncSessionLifecycle()
    }

    fun setMeasureVisible(visible: Boolean) {
        measureVisible = visible
        updateKeepScreenOn()
        syncSessionLifecycle()
    }

    fun setDetectVisible(visible: Boolean) {
        detectVisible = visible
        renderer.tapMode =
            if (visible) ArProbeRenderer.TapMode.CANDIDATE else ArProbeRenderer.TapMode.MEASURE
        renderer.frameHook =
            if (visible) ({ frame, nowNs -> detectorEngine.onGlFrame(frame, nowNs) }) else null
        updateKeepScreenOn()
        syncSessionLifecycle()
    }

    private fun updateKeepScreenOn() {
        if (measureVisible || detectVisible) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun wireDetectorCallbacks() {
        detectorEngine.onResult = { result ->
            renderer.imageBoxes = result.imageBoxes.map { (track, box) ->
                CandidateImageBox(
                    trackId = track.id,
                    category = com.roomrelay.app.core.inference.categoryFromCocoLabel(track.cocoLabel),
                    cocoLabel = track.cocoLabel,
                    score = track.score,
                    box = box,
                    ambiguous = track.state == com.roomrelay.app.core.association.TrackState.AMBIGUOUS,
                )
            }
            handler.post {
                mutableState.update { state ->
                    state.copy(
                        detect = state.detect.copy(
                            tentativeCount = result.tracks.count {
                                it.state == com.roomrelay.app.core.association.TrackState.TENTATIVE
                            },
                            stableCount = result.tracks.count {
                                it.state == com.roomrelay.app.core.association.TrackState.STABLE
                            },
                            ambiguousCount = result.tracks.count {
                                it.state == com.roomrelay.app.core.association.TrackState.AMBIGUOUS
                            },
                        ),
                    )
                }
            }
        }
        renderer.onOverlay = { boxes ->
            handler.post {
                mutableState.update { state ->
                    state.copy(detect = state.detect.copy(overlayBoxes = boxes))
                }
            }
        }
        renderer.onCandidateAnchor = { trackId, anchor, hitType ->
            handler.post { onCandidateAnchor(trackId, anchor, hitType) }
        }
        renderer.onTapMessage = { message ->
            handler.post {
                mutableState.update { state ->
                    state.copy(detect = state.detect.copy(message = message))
                }
            }
        }
    }

    private fun thermalStatusFromInt(status: Int): ThermalStatus = when (status) {
        PowerManager.THERMAL_STATUS_NONE -> ThermalStatus.NONE
        PowerManager.THERMAL_STATUS_LIGHT -> ThermalStatus.LIGHT
        PowerManager.THERMAL_STATUS_MODERATE -> ThermalStatus.MODERATE
        PowerManager.THERMAL_STATUS_SEVERE -> ThermalStatus.SEVERE
        PowerManager.THERMAL_STATUS_CRITICAL -> ThermalStatus.CRITICAL
        PowerManager.THERMAL_STATUS_EMERGENCY -> ThermalStatus.EMERGENCY
        PowerManager.THERMAL_STATUS_SHUTDOWN -> ThermalStatus.SHUTDOWN
        else -> ThermalStatus.UNKNOWN
    }

    private fun registerThermalListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val powerManager = activity.getSystemService(PowerManager::class.java) ?: return
        // Seed engine + UI with the current status so telemetry has a
        // thermalStart even when the status never changes.
        applyThermalStatus(thermalStatusFromInt(powerManager.currentThermalStatus))
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            applyThermalStatus(thermalStatusFromInt(status))
        }
        powerManager.addThermalStatusListener(listener)
        thermalListener = listener
    }

    private fun applyThermalStatus(mapped: ThermalStatus) {
            detectorEngine.setThermalStatus(mapped, SystemClock.elapsedRealtimeNanos())
            handler.post {
                mutableState.update { state ->
                    state.copy(
                        detect = state.detect.copy(
                            thermalStatus = mapped.name,
                            inferencePaused =
                                com.roomrelay.app.core.inference.ThermalPolicy.isPaused(mapped),
                            statusLine = when {
                                com.roomrelay.app.core.inference.ThermalPolicy.isPaused(mapped) ->
                                    "Phone is too hot — detection paused"
                                mapped == ThermalStatus.SEVERE || mapped == ThermalStatus.MODERATE ->
                                    "Phone is warm — detection slowed"
                                else -> state.detect.statusLine
                            },
                        ),
                    )
                }
        }
    }

    private fun rotationToDegrees(rotation: Int): Int = when (rotation) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    private fun sensorOrientationDeg(): Int {
        val cameraId = session?.cameraConfig?.cameraId ?: return 90
        return try {
            val manager = activity.getSystemService(android.content.Context.CAMERA_SERVICE)
                as android.hardware.camera2.CameraManager
            val characteristics = manager.getCameraCharacteristics(cameraId)
            characteristics.get(
                android.hardware.camera2.CameraCharacteristics.SENSOR_ORIENTATION,
            ) ?: 90
        } catch (_: Exception) {
            90
        }
    }

    fun createGlView(): GLSurfaceView {
        return GLSurfaceView(activity).apply {
            setEGLContextClientVersion(2)
            preserveEGLContextOnPause = true
            setRenderer(renderer)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
            setOnTouchListener { view, event ->
                if (event.action == MotionEvent.ACTION_UP) {
                    renderer.queueTap(event)
                    view.performClick()
                }
                true
            }
            glView = this
            syncSessionLifecycle()
        }
    }

    fun releaseGlView(view: GLSurfaceView) {
        if (glView === view) {
            syncSessionLifecycle(forcePause = true)
            glView = null
        }
    }

    fun startSessionLog() {
        if (session == null || !sessionResumed) {
            updateMeasureMessage("Start an AR measurement session before logging.")
            return
        }
        sessionLogger.start(
            SystemClock.elapsedRealtimeNanos(),
            thermalStatus(),
            if (automaticDepthEnabled) "AUTOMATIC" else "DISABLED",
        )
        mutableState.update { state ->
            state.copy(
                sessionLog = null,
                sessionLogRunning = true,
                sessionElapsedS = 0L,
            )
        }
    }

    fun stopSessionLog() {
        if (!sessionLogger.isRunning) return
        sessionLogger.stop(
            SystemClock.elapsedRealtimeNanos(),
            thermalStatus(),
            "STOPPED_BY_USER",
        )
        publishSessionLog()
    }

    fun saveTrial(tapeText: String, label: String) {
        val tapeCm = parseTapeCm(tapeText)
        var trialSaved = false
        mutableState.update { state ->
            trialSaved = false
            val measurement = state.measure
            val pairId = measurement.pairId
            if (pairId == null || pairId == state.lastSavedPairId) {
                state.copy(
                    measure = measurement.copy(
                        message = "This point pair is already saved. Reset or tap new points.",
                    ),
                )
            } else {
                val arcoreM = measurement.distanceMeters
                if (tapeCm == null || arcoreM == null || !measurement.hasBothAnchors) {
                    state.copy(
                        measure = measurement.copy(
                            message = "Set two points and enter a valid tape length in centimeters.",
                        ),
                    )
                } else {
                    val error = computeError(tapeCm, arcoreM)
                    if (error == null) {
                        state.copy(
                            measure = measurement.copy(
                                message = "The measurement could not be compared with the tape length.",
                            ),
                        )
                    } else {
                        val index = state.trials.size + 1
                        val trial = MeasurementTrial(
                            index = index,
                            label = label.trim().ifBlank { "Trial $index" },
                            recordedAtUtc = utcNow(),
                            tapeCm = tapeCm,
                            arcoreM = arcoreM,
                            errorCm = error.errorCm,
                            errorPct = error.errorPct,
                            hitTypes = listOfNotNull(measurement.firstHitType, measurement.secondHitType),
                            trackingAtMeasure = measurement.trackingState,
                            anchorTrackingAtMeasure = measurement.anchorTracking,
                        )
                        trialSaved = true
                        state.copy(
                            trials = state.trials + trial,
                            measure = measurement.copy(
                                distanceMeters = null,
                                firstHitType = null,
                                secondHitType = null,
                                hasBothAnchors = false,
                                pairId = null,
                                anchorTracking = emptyList(),
                                message = "Trial saved. Tap to start another measurement.",
                            ),
                            lastSavedPairId = pairId,
                        )
                    }
                }
            }
        }
        if (trialSaved) {
            renderer.resetPoints(message = "Trial saved. Tap to start another measurement.")
        }
    }

    fun resetPoints() {
        renderer.resetPoints()
        mutableState.update { state ->
            state.copy(
                measure = state.measure.copy(
                    distanceMeters = null,
                    firstHitType = null,
                    secondHitType = null,
                    hasBothAnchors = false,
                    pairId = null,
                    anchorTracking = emptyList(),
                    message = "Points reset",
                ),
            )
        }
    }

    fun deleteTrial(index: Int) {
        mutableState.update { state ->
            val remaining = state.trials.filterNot { it.index == index }
                .mapIndexed { position, trial -> trial.copy(index = position + 1) }
            state.copy(trials = remaining)
        }
    }

    fun updateNotes(notes: String) {
        mutableState.update { it.copy(notes = notes) }
    }

    fun exportAndShare() {
        try {
            val report = buildReport()
            val reportDirectory = File(activity.filesDir, "reports")
            if (!reportDirectory.exists() && !reportDirectory.mkdirs()) {
                throw IllegalStateException("Report directory could not be created")
            }
            val fileName = "roomrelay-probe-${fileTimestamp()}.json"
            val reportFile = File(reportDirectory, fileName)
            reportFile.writeText(encodeReport(report), Charsets.UTF_8)
            val uri = FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                reportFile,
            )
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                clipData = android.content.ClipData.newUri(
                    activity.contentResolver,
                    fileName,
                    uri,
                )
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(shareIntent, "Share probe report"))
            mutableState.update {
                it.copy(
                    reportFileName = fileName,
                    reportMessage = "Report saved and ready to share.",
                )
            }
        } catch (exception: Exception) {
            mutableState.update {
                it.copy(reportMessage = "Report could not be exported (${exception.javaClass.simpleName}).")
            }
        }
    }

    fun close() {
        handler.removeCallbacksAndMessages(null)
        activityResumed = false
        measureVisible = false
        detectVisible = false
        syncSessionLifecycle(forcePause = true)
        if (sessionLogger.isRunning) stopSessionLog()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            thermalListener?.let {
                activity.getSystemService(PowerManager::class.java)
                    ?.removeThermalStatusListener(it)
            }
        }
        detectorEngine.close()
        syncExecutor.shutdown()
        pendingConfirm?.anchor?.detach()
        pendingConfirm = null
        itemAnchors.values.forEach { it.detach() }
        itemAnchors.clear()
        glView = null
        session?.close()
        session = null
    }

    private fun pollAvailability() {
        val currentPolls = mutableState.value.capability.availabilityPolls
        val availability = try {
            ArCoreApk.getInstance().checkAvailability(activity.applicationContext)
        } catch (exception: Exception) {
            updateCapability {
                copy(
                    availability = exception.javaClass.simpleName,
                    availabilityPolls = currentPolls + 1,
                    checkingAvailability = false,
                    sessionErrorClass = exception.javaClass.simpleName,
                    sessionErrorMessage = "AR capability check failed (${exception.javaClass.simpleName}).",
                )
            }
            return
        }
        val polls = currentPolls + 1
        updateCapability {
            copy(
                availability = availability.name,
                availabilityPolls = polls,
                checkingAvailability = availability.isTransient && polls < MAX_AVAILABILITY_POLLS,
            )
        }
        if (availability.isTransient && polls < MAX_AVAILABILITY_POLLS) {
            handler.postDelayed(::pollAvailability, AVAILABILITY_POLL_INTERVAL_MS)
        } else if (availability == ArCoreApk.Availability.SUPPORTED_INSTALLED) {
            refreshArServicesPackage()
            createSessionIfReady()
        }
    }

    private fun refreshArServicesPackage() {
        val info = try {
            activity.packageManager.getPackageInfo(ARCORE_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            null
        }
        updateCapability {
            copy(
                arServicesInstalled = info != null,
                arServicesVersionName = info?.versionName,
                arServicesVersionCode = info?.let(PackageInfoCompat::getLongVersionCode),
            )
        }
    }

    private fun completeInstallRequest() {
        try {
            val result = ArCoreApk.getInstance().requestInstall(activity, false)
            updateCapability { copy(installRequestResult = result.name) }
            if (result == ArCoreApk.InstallStatus.INSTALL_REQUESTED) return
            installRequestPending = false
            refreshCapabilities()
        } catch (exception: Exception) {
            installRequestPending = false
            updateCapability {
                copy(
                    installRequestResult = exception.javaClass.simpleName,
                    sessionErrorClass = exception.javaClass.simpleName,
                    sessionErrorMessage = "AR services installation did not complete (${exception.javaClass.simpleName}).",
                )
            }
        }
    }

    private fun createSessionIfReady() {
        val capability = mutableState.value.capability
        if (session != null ||
            capability.cameraPermission != "GRANTED" ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED ||
            !capability.arServicesInstalled ||
            capability.availability != ArCoreApk.Availability.SUPPORTED_INSTALLED.name
        ) {
            return
        }
        var pendingSession: Session? = null
        try {
            val created = Session(activity)
            pendingSession = created
            val automaticDepth = created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
            val rawDepth = created.isDepthModeSupported(Config.DepthMode.RAW_DEPTH_ONLY)
            val filter = CameraConfigFilter(created)
                .setTargetFps(EnumSet.allOf(CameraConfig.TargetFps::class.java))
                .setDepthSensorUsage(EnumSet.allOf(CameraConfig.DepthSensorUsage::class.java))
                .setStereoCameraUsage(EnumSet.allOf(CameraConfig.StereoCameraUsage::class.java))
                .setFacingDirection(CameraConfig.FacingDirection.BACK)
            val cameraConfigs = created.getSupportedCameraConfigs(filter).map(::cameraConfigInfo)
            val config = Config(created).apply {
                depthMode = if (automaticDepth) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                focusMode = Config.FocusMode.AUTO
                instantPlacementMode = Config.InstantPlacementMode.DISABLED
                updateMode = Config.UpdateMode.BLOCKING
            }
            try {
                created.configure(config)
                configureErrorClass = null
                configureErrorMessage = null
            } catch (exception: Exception) {
                configureErrorClass = exception.javaClass.simpleName
                configureErrorMessage =
                    "AR session configuration failed (${exception.javaClass.simpleName})."
            }
            automaticDepthEnabled = automaticDepth
            session = created
            pendingSession = null
            updateCapability {
                copy(
                    sessionCreated = true,
                    sessionErrorClass = null,
                    sessionErrorMessage = null,
                    depthAutomaticSupported = automaticDepth,
                    rawDepthOnlySupported = rawDepth,
                    cameraConfigs = cameraConfigs,
                    configureErrorClass = configureErrorClass,
                    configureErrorMessage = configureErrorMessage,
                )
            }
            syncSessionLifecycle()
        } catch (exception: Exception) {
            try {
                pendingSession?.close()
            } catch (_: Exception) {}
            updateCapability {
                copy(
                    sessionCreated = false,
                    sessionErrorClass = exception.javaClass.simpleName,
                    sessionErrorMessage =
                        "AR session could not be created. Check Google Play Services for AR and camera permission (${exception.javaClass.simpleName}).",
                )
            }
        }
    }

    private fun cameraConfigInfo(config: CameraConfig): CameraConfigInfo {
        val imageSize = config.imageSize
        val textureSize = config.textureSize
        return CameraConfigInfo(
            cameraId = config.cameraId,
            facing = config.facingDirection.name,
            imageWidth = imageSize.width,
            imageHeight = imageSize.height,
            textureWidth = textureSize.width,
            textureHeight = textureSize.height,
            fpsMin = config.fpsRange.lower,
            fpsMax = config.fpsRange.upper,
            depthSensorUsage = config.depthSensorUsage.name,
            stereoCameraUsage = config.stereoCameraUsage.name,
        )
    }

    private fun syncSessionLifecycle(forcePause: Boolean = false) {
        val shouldResume = !forcePause &&
            activityResumed &&
            (measureVisible || detectVisible) &&
            glView != null &&
            session != null &&
            mutableState.value.capability.cameraPermission == "GRANTED"
        if (shouldResume &&
            ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED &&
            !sessionResumed
        ) {
            try {
                glView?.onResume()
                session?.resume()
                sessionResumed = true
                sessionLogger.onResume(SystemClock.elapsedRealtimeNanos())
                if (sessionLogger.shouldFinish(SystemClock.elapsedRealtimeNanos())) {
                    sessionLogger.stop(
                        SystemClock.elapsedRealtimeNanos(),
                        thermalStatus(),
                        "COMPLETED_AFTER_PAUSE",
                    )
                    publishSessionLog()
                }
                session?.let { current ->
                    mutableState.update { state ->
                        state.copy(
                            capability = state.capability.copy(
                                activeCameraConfig = cameraConfigInfo(current.cameraConfig),
                            ),
                        )
                    }
                }
                renderer.publishStatus("AR session active")
            } catch (exception: Exception) {
                updateCapability {
                    copy(
                        sessionErrorClass = exception.javaClass.simpleName,
                        sessionErrorMessage =
                            "AR session could not resume (${exception.javaClass.simpleName}).",
                    )
                }
            }
        } else if ((!shouldResume || forcePause) && sessionResumed) {
            val nowNs = SystemClock.elapsedRealtimeNanos()
            if (sessionLogger.isRunning) sessionLogger.onPause(nowNs)
            renderer.discardPendingTaps()
            try {
                session?.pause()
            } catch (exception: Exception) {
                updateCapability {
                    copy(
                        sessionErrorClass = exception.javaClass.simpleName,
                        sessionErrorMessage =
                            "AR session could not pause cleanly (${exception.javaClass.simpleName}).",
                    )
                }
            }
            glView?.onPause()
            sessionResumed = false
        }
    }

    private fun onRendererFrame(snapshot: MeasureSnapshot, nowNs: Long) {
        if (sessionLogger.isRunning) {
            sessionLogger.onFrame(nowNs, renderer.drainObservation())
            if (sessionLogger.shouldFinish(nowNs)) {
                sessionLogger.stop(nowNs, thermalStatus(), "COMPLETED")
                publishSessionLog()
            }
        }
        // Tracking breaks pause association; resume clears stale 2D tracks.
        val tracking = snapshot.trackingState
        if (tracking != lastTrackingState) {
            if (lastTrackingState == TrackingState.TRACKING.name &&
                tracking != TrackingState.TRACKING.name
            ) {
                trackingBreaks += 1
                detectorEngine.pauseAssociation()
            } else if (tracking == TrackingState.TRACKING.name &&
                lastTrackingState != "STOPPED" && detectorEngine.tracker.paused
            ) {
                detectorEngine.resumeAssociation()
            }
            lastTrackingState = tracking
        }
        if (nowNs - lastUiPublishNs < UI_PUBLISH_INTERVAL_NS) return
        lastUiPublishNs = nowNs
        val telemetry = detectorEngine.telemetry.snapshot()
        mutableState.update { state ->
            state.copy(
                measure = snapshot,
                sessionLogRunning = sessionLogger.isRunning,
                sessionElapsedS =
                    if (sessionLogger.isRunning) sessionLogger.elapsedS(nowNs) else state.sessionElapsedS,
                detect = state.detect.copy(
                    trackingState = snapshot.trackingState,
                    achievedFps = telemetry.achievedFps,
                    latencyP50Ms = telemetry.latencyP50Ms,
                    statusLine = when {
                        detectorEngine.detectorError != null -> detectorEngine.detectorError!!
                        state.detect.inferencePaused -> "Phone is too hot — detection paused"
                        detectorEngine.tracker.paused ->
                            "Camera tracking lost — item association paused until tracking returns"
                        else -> "Detection running"
                    },
                ),
            )
        }
    }

    // ---- Candidate confirm + capture drafts + sync ----

    private fun onCandidateAnchor(trackId: Long, anchor: Anchor, hitType: String) {
        val track = detectorEngine.tracker.tracks().firstOrNull { it.id == trackId }
        if (track == null) {
            anchor.detach()
            mutableState.update { it.copy(detect = it.detect.copy(message = "That item moved — tap again.")) }
            return
        }
        val category = com.roomrelay.app.core.inference.categoryFromCocoLabel(track.cocoLabel)
        if (category == null) {
            anchor.detach()
            mutableState.update {
                it.copy(detect = it.detect.copy(message = "That detection is not a furniture type."))
            }
            return
        }
        val pose = anchor.pose
        pendingConfirm = PendingConfirm(
            trackId = trackId,
            anchor = anchor,
            hitType = hitType,
            trackingState = track.let { mutableState.value.measure.trackingState },
            cocoLabel = track.cocoLabel,
            score = track.score,
            evidence = DetectionEvidence(
                cocoLabel = track.cocoLabel,
                score = track.score,
                frameTimeNs = track.lastSeenNs,
                boxImagePx = listOf(track.box.left, track.box.top, track.box.right, track.box.bottom),
            ),
        )
        val position = Vec3(pose.tx().toDouble(), pose.ty().toDouble(), pose.tz().toDouble())
        when (val decision = itemRegistry.decide(category, position)) {
            is MergeDecision.SameAsExisting ->
                mutableState.update {
                    it.copy(
                        ask = AskState(
                            candidateIds = listOf(decision.itemId),
                            prompt = "This looks like item ${decision.itemId} you already confirmed. Same item, or a new one?",
                        ),
                    )
                }
            is MergeDecision.Ask ->
                mutableState.update {
                    it.copy(
                        ask = AskState(
                            candidateIds = decision.candidateIds,
                            prompt = "Several similar items here — same as one of these, or a new item?",
                        ),
                    )
                }
            MergeDecision.NewItem -> confirmCandidateAsNew(category, position)
        }
    }

    /** Ask dialog: the tapped candidate is the same as an existing item. */
    fun resolveAskSame(itemId: Long) {
        dismissAsk(detach = true)
        mutableState.update {
            it.copy(
                detect = it.detect.copy(
                    message = "Kept as item $itemId — no duplicate added.",
                ),
            )
        }
    }

    /** Ask dialog: the tapped candidate is a different, new item. */
    fun resolveAskNew() {
        val pending = pendingConfirm ?: run {
            dismissAsk(detach = false)
            return
        }
        val pose = pending.anchor.pose
        val category = com.roomrelay.app.core.inference.categoryFromCocoLabel(pending.cocoLabel)
        dismissAsk(detach = false)
        if (category != null) {
            confirmCandidateAsNew(
                category,
                Vec3(pose.tx().toDouble(), pose.ty().toDouble(), pose.tz().toDouble()),
                keepPending = pending,
            )
        }
    }

    fun dismissAsk(detach: Boolean = true) {
        if (detach) pendingConfirm?.anchor?.detach()
        pendingConfirm = null
        mutableState.update { it.copy(ask = null) }
    }

    private fun confirmCandidateAsNew(
        category: RoomRelayCategory,
        position: Vec3,
        keepPending: PendingConfirm? = pendingConfirm,
    ) {
        val pending = keepPending ?: return
        val item = itemRegistry.add(category, position)
        val localId = item.id.toString()
        itemAnchors[localId] = pending.anchor
        val pose = pending.anchor.pose
        val captured = CapturedItem(
            localId = localId,
            category = category,
            categorySource = com.roomrelay.app.core.capture.CategorySource.MODEL_DETECTED,
            categoryCocoLabel = pending.cocoLabel,
            categoryScore = pending.score,
            categoryModelId = DETECTOR_MODEL_ID,
            anchor = CaptureAnchor(
                translation = listOf(pose.tx().toDouble(), pose.ty().toDouble(), pose.tz().toDouble()),
                rotationQuaternion = listOf(
                    pose.qx().toDouble(), pose.qy().toDouble(),
                    pose.qz().toDouble(), pose.qw().toDouble(),
                ),
                hitType = pending.hitType,
                trackingStateAtConfirm = pending.trackingState,
                confirmedAtUtc = utcNow(),
            ),
            detectionEvidence = pending.evidence,
        )
        upsertItemDraft(captured)
        pendingConfirm = null
        mutableState.update {
            it.copy(
                ask = null,
                detect = it.detect.copy(
                    message = "Item $localId added (${category.name.lowercase()}). Measure it on the Items tab.",
                ),
            )
        }
    }

    /** Manual item entry: a draft item with a user-picked category. */
    fun addManualItem(category: RoomRelayCategory, freeText: String?) {
        val localId = UUID.randomUUID().toString().take(8)
        val captured = CapturedItem(
            localId = localId,
            category = category,
            categorySource = com.roomrelay.app.core.capture.CategorySource.USER_MANUAL,
            freeTextLabel = freeText?.trim()?.ifBlank { null },
        )
        upsertItemDraft(captured)
        mutableState.update {
            it.copy(queueMessage = "Item $localId added manually. Measure it to queue for upload.")
        }
    }

    /**
     * Adds or replaces the item in its single-item ITEM draft. One item per
     * ITEM capture, matching validateForUpload.
     */
    private fun upsertItemDraft(item: CapturedItem) {
        val existing = mutableState.value.drafts.firstOrNull {
            it.kind == CaptureKind.ITEM && it.items.firstOrNull()?.localId == item.localId
        }
        val session = existing?.copy(items = listOf(item)) ?: CaptureSession(
            clientCaptureId = UUID.randomUUID().toString(),
            kind = CaptureKind.ITEM,
            consentVersion = CONSENT_VERSION,
            createdAtUtc = utcNow(),
            device = captureDevice(),
            frameId = "arcore-session:${sessionUuid()}",
            trackingBreaks = trackingBreaks,
        )
        draftStore.save(session)
        mutableState.update { it.copy(drafts = draftStore.list()) }
    }

    private val captureSessionUuid = UUID.randomUUID().toString()

    private fun sessionUuid(): String = captureSessionUuid

    private fun captureDevice(): CaptureDevice = CaptureDevice(
        manufacturer = Build.MANUFACTURER,
        model = Build.MODEL,
        sdkInt = Build.VERSION.SDK_INT,
        appVersion = BuildConfig.VERSION_NAME,
        arcoreSdkVersion = "1.56.0",
        detectorModelId = DETECTOR_MODEL_ID,
    )

    /** Records a confirmed dimension for an item; the only path to dimensions. */
    fun setItemDimension(
        clientCaptureId: String,
        localId: String,
        axis: CaptureAxis,
        valueM: Double,
        source: DimensionSource,
    ) {
        if (!valueM.isFinite() || valueM <= 0.0 || valueM > 10.0) {
            mutableState.update { it.copy(queueMessage = "Dimension must be between 0 and 10 m.") }
            return
        }
        val draft = mutableState.value.drafts.firstOrNull { it.clientCaptureId == clientCaptureId }
            ?: return
        val item = draft.items.firstOrNull { it.localId == localId } ?: return
        val measure = mutableState.value.measure
        val nextRevision = (item.dimensions.filter { it.axis == axis }
            .maxOfOrNull { it.revision } ?: 0) + 1
        val updated = item.copy(
            dimensions = item.dimensions.filterNot { it.axis == axis } + DimensionMeasurement(
                axis = axis,
                valueM = valueM,
                source = source,
                confirmedByUser = true,
                actor = "device-user",
                confirmedAtUtc = utcNow(),
                revision = nextRevision,
                hitTypes = if (source == DimensionSource.ARCORE_ESTIMATED) {
                    listOfNotNull(measure.firstHitType, measure.secondHitType).ifEmpty { null }
                } else {
                    null
                },
                trackingState = if (source == DimensionSource.ARCORE_ESTIMATED) {
                    measure.trackingState
                } else {
                    null
                },
            ),
        )
        draftStore.save(draft.copy(items = listOf(updated)))
        mutableState.update {
            it.copy(
                drafts = draftStore.list(),
                queueMessage = "${axis.name.lowercase()} saved for item $localId.",
            )
        }
    }

    /** Typed centimeters -> meters dimension via the shared tape parser. */
    fun setItemDimensionCm(
        clientCaptureId: String,
        localId: String,
        axis: CaptureAxis,
        tapeText: String,
    ) {
        val cm = parseTapeCm(tapeText)
        if (cm == null) {
            mutableState.update { it.copy(queueMessage = "Enter a tape length in centimeters.") }
            return
        }
        setItemDimension(clientCaptureId, localId, axis, cm / 100.0, DimensionSource.USER_MEASURED)
    }

    /** Two-point AR estimate confirmed by the user. */
    fun confirmArEstimateDimension(
        clientCaptureId: String,
        localId: String,
        axis: CaptureAxis,
    ) {
        val measure = mutableState.value.measure
        val distance = measure.distanceMeters
        if (distance == null || !measure.hasBothAnchors) {
            mutableState.update {
                it.copy(queueMessage = "Set two points on the Measure tab first.")
            }
            return
        }
        setItemDimension(clientCaptureId, localId, axis, distance, DimensionSource.ARCORE_ESTIMATED)
    }

    fun deleteDraft(clientCaptureId: String) {
        val draft = mutableState.value.drafts.firstOrNull { it.clientCaptureId == clientCaptureId }
        draft?.items?.forEach { item ->
            itemAnchors.remove(item.localId)?.detach()
        }
        draftStore.delete(clientCaptureId)
        mutableState.update { it.copy(drafts = draftStore.list()) }
    }

    /** Validates a draft and enqueues its manifest for upload. */
    fun queueUpload(clientCaptureId: String) {
        val draft = mutableState.value.drafts.firstOrNull { it.clientCaptureId == clientCaptureId }
            ?: return
        val errors = draft.validateForUpload()
        if (errors.isNotEmpty()) {
            mutableState.update {
                it.copy(queueMessage = "Not ready: ${errors.joinToString(" ")}")
            }
            return
        }
        val payload = Json { encodeDefaults = true }.encodeToString(
            CaptureSession.serializer(), draft,
        ).toByteArray(Charsets.UTF_8)
        val job = uploadClient.enqueue(draft, payload)
        mutableState.update {
            it.copy(
                uploadJobs = uploadStore.list(),
                queueMessage = "Item queued for upload (job ${job.jobId.take(8)}).",
                syncBanner = syncBannerText(),
            )
        }
        runPendingUploads()
    }

    /** "Sync now": retries due and scheduled jobs immediately. */
    fun syncNow() {
        runPendingUploads(force = true)
    }

    private fun runPendingUploads(force: Boolean = false) {
        syncExecutor.execute {
            val jobs = try {
                uploadClient.runPending(force)
            } catch (_: Exception) {
                uploadStore.list()
            }
            handler.post {
                mutableState.update {
                    it.copy(
                        uploadJobs = jobs,
                        syncBanner = syncBannerText(),
                    )
                }
            }
        }
    }

    private fun syncBannerText(): String? {
        val config = SyncConfig.parse(BuildConfig.ROOMRELAY_API_BASE_URL)
        if (config is SyncConfig.Unavailable) return "Sync unavailable: ${config.reason}."
        return when (val token = authTokenProvider.currentToken()) {
            is com.roomrelay.app.core.sync.TokenResult.Available -> null
            is com.roomrelay.app.core.sync.TokenResult.Unavailable ->
                "Sync unavailable: ${token.reason}."
        }
    }

    fun uploadStatusText(job: UploadJob): String = when (job.status) {
        UploadStatus.PENDING -> "Waiting to upload"
        UploadStatus.RUNNING -> "Uploading"
        UploadStatus.RETRY_SCHEDULED -> "Will retry — ${job.lastError ?: "network problem"}"
        UploadStatus.AUTH_REQUIRED -> "Sign-in needed before upload"
        UploadStatus.AUTH_UNAVAILABLE -> job.lastError ?: "Sign-in unavailable"
        UploadStatus.SYNC_UNAVAILABLE -> job.lastError ?: "Sync unavailable"
        UploadStatus.FORBIDDEN -> "This capture belongs to a different account"
        UploadStatus.NOT_FOUND -> "Capture no longer exists on the server"
        UploadStatus.FAILED -> "Upload failed: ${job.lastError ?: "unknown error"}"
        UploadStatus.COMPLETED -> "Uploaded"
    }

    private fun onRendererStatus(status: String) {
        mutableState.update { state ->
            state.copy(measure = state.measure.copy(status = status, message = status))
        }
    }

    private fun updateCapability(update: CapabilitySnapshot.() -> CapabilitySnapshot) {
        mutableState.update { state -> state.copy(capability = state.capability.update()) }
    }

    private fun updateMeasureMessage(message: String) {
        mutableState.update { state -> state.copy(measure = state.measure.copy(message = message)) }
    }

    private fun publishSessionLog() {
        mutableState.update {
            it.copy(
                sessionLog = sessionLogger.result(),
                sessionLogRunning = false,
                sessionElapsedS = sessionLogger.elapsedS(SystemClock.elapsedRealtimeNanos()),
            )
        }
    }

    private fun buildReport(): ProbeReport {
        val capability = mutableState.value.capability
        return ProbeReport(
            generatedAtUtc = utcNow(),
            app = AppInfo(
                packageName = activity.packageName,
                versionName = BuildConfig.VERSION_NAME,
                versionCode = BuildConfig.VERSION_CODE.toLong(),
                buildType = BuildConfig.BUILD_TYPE,
            ),
            device = DeviceInfo(
                manufacturer = Build.MANUFACTURER,
                model = Build.MODEL,
                device = Build.DEVICE,
                sdkInt = Build.VERSION.SDK_INT,
                release = Build.VERSION.RELEASE,
            ),
            capabilities = Capabilities(
                arServicesInstalled = capability.arServicesInstalled,
                arServicesVersionName = capability.arServicesVersionName,
                arServicesVersionCode = capability.arServicesVersionCode,
                availability = capability.availability,
                availabilityPolls = capability.availabilityPolls,
                installRequestResult = capability.installRequestResult,
                cameraPermission = capability.cameraPermission,
                sessionCreated = capability.sessionCreated,
                sessionErrorClass = capability.sessionErrorClass,
                sessionErrorMessage = capability.sessionErrorMessage,
                depthAutomaticSupported = capability.depthAutomaticSupported,
                rawDepthOnlySupported = capability.rawDepthOnlySupported,
                activeCameraConfig = capability.activeCameraConfig,
                configureErrorClass = capability.configureErrorClass,
            ),
            cameraConfigs = capability.cameraConfigs,
            measurements = mutableState.value.trials,
            sessionLog = if (sessionLogger.isRunning) null else sessionLogger.result(),
            notes = mutableState.value.notes,
            detectorModel = DetectorModelInfo(
                id = DETECTOR_MODEL_ID,
                url = DETECTOR_MODEL_URL,
                sha256 = DETECTOR_MODEL_SHA256,
            ),
            inference = detectorEngine.telemetry.snapshot(),
            captures = draftStore.list(),
        )
    }

    private fun cameraPermissionStatus(): String =
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            "GRANTED"
        } else {
            "DENIED"
        }

    private fun thermalStatus(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "UNAVAILABLE_API_BELOW_29"
        val powerManager = activity.getSystemService(PowerManager::class.java)
            ?: return "UNAVAILABLE"
        return when (powerManager.currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE -> "NONE"
            PowerManager.THERMAL_STATUS_LIGHT -> "LIGHT"
            PowerManager.THERMAL_STATUS_MODERATE -> "MODERATE"
            PowerManager.THERMAL_STATUS_SEVERE -> "SEVERE"
            PowerManager.THERMAL_STATUS_CRITICAL -> "CRITICAL"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "EMERGENCY"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "SHUTDOWN"
            else -> "UNKNOWN"
        }
    }

    private fun utcNow(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    private fun fileTimestamp(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    private companion object {
        const val ARCORE_PACKAGE = "com.google.ar.core"
        const val MAX_AVAILABILITY_POLLS = 50
        const val AVAILABILITY_POLL_INTERVAL_MS = 200L
        const val UI_PUBLISH_INTERVAL_NS = 100_000_000L
        const val CONSENT_VERSION = "capture-consent-v1"
    }
}
