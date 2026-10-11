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
import com.google.ar.core.ArCoreApk
import com.google.ar.core.CameraConfig
import com.google.ar.core.CameraConfigFilter
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.roomrelay.app.core.AppInfo
import com.roomrelay.app.core.CameraConfigInfo
import com.roomrelay.app.core.Capabilities
import com.roomrelay.app.core.DeviceInfo
import com.roomrelay.app.core.MeasurementTrial
import com.roomrelay.app.core.ProbeReport
import com.roomrelay.app.core.SessionLogger
import com.roomrelay.app.core.computeError
import com.roomrelay.app.core.encodeReport
import com.roomrelay.app.core.parseTapeCm
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

internal data class ProbeUiState(
    val capability: CapabilitySnapshot = CapabilitySnapshot(),
    val measure: MeasureSnapshot = MeasureSnapshot(),
    val trials: List<MeasurementTrial> = emptyList(),
    val lastSavedPairId: Long? = null,
    val notes: String = "",
    val sessionLog: com.roomrelay.app.core.SessionLog? = null,
    val sessionLogRunning: Boolean = false,
    val sessionElapsedS: Long = 0L,
    val reportFileName: String? = null,
    val reportMessage: String = "",
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
    private var sessionResumed = false
    private var installRequestPending = false
    private var lastUiPublishNs = 0L
    private var configureErrorClass: String? = null
    private var configureErrorMessage: String? = null

    init {
        renderer = ArProbeRenderer(
            sessionProvider = { session },
            depthEnabled = { automaticDepthEnabled },
            displayRotation = { glView?.display?.rotation ?: Surface.ROTATION_0 },
            onFrame = ::onRendererFrame,
            onStatus = ::onRendererStatus,
        )
        refreshCapabilities()
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
        if (visible) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
        syncSessionLifecycle()
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
        syncSessionLifecycle(forcePause = true)
        if (sessionLogger.isRunning) stopSessionLog()
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
            measureVisible &&
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
        if (nowNs - lastUiPublishNs < UI_PUBLISH_INTERVAL_NS) return
        lastUiPublishNs = nowNs
        mutableState.update { state ->
            state.copy(
                measure = snapshot,
                sessionLogRunning = sessionLogger.isRunning,
                sessionElapsedS =
                    if (sessionLogger.isRunning) sessionLogger.elapsedS(nowNs) else state.sessionElapsedS,
            )
        }
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
    }
}
