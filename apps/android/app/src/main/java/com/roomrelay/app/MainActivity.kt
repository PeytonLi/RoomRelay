package com.roomrelay.app

import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.roomrelay.app.core.PROTOCOL_CONDITIONS
import com.roomrelay.app.core.TRIALS_PER_CONDITION
import com.roomrelay.app.core.TrialDistance
import com.roomrelay.app.core.TrialSurface
import com.roomrelay.app.core.displayName
import com.roomrelay.app.core.formatCm
import com.roomrelay.app.core.formatMeters
import com.roomrelay.app.core.formatSignedCm
import com.roomrelay.app.core.formatSignedPct
import com.roomrelay.app.core.parseTapeCm
import com.roomrelay.app.core.summarizeTrials
import java.util.Locale

class MainActivity : ComponentActivity() {
    private lateinit var controller: ProbeController

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            controller.onCameraPermissionResult(granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        controller = ProbeController(this)
        setContent {
            RoomRelayProbeApp(
                controller = controller,
                onRequestCameraPermission = {
                    cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)
                },
            )
        }
    }

    override fun onResume() {
        super.onResume()
        if (::controller.isInitialized) controller.onActivityResume()
    }

    override fun onPause() {
        if (::controller.isInitialized) controller.onActivityPause()
        super.onPause()
    }

    override fun onDestroy() {
        if (::controller.isInitialized) controller.close()
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoomRelayProbeApp(
    controller: ProbeController,
    onRequestCameraPermission: () -> Unit,
) {
    val state by controller.state.collectAsState()
    var selectedTab by rememberSaveable { mutableIntStateOf(0) }
    val tabLabels = listOf("Capability", "Measure", "Report")

    LaunchedEffect(selectedTab) {
        controller.setMeasureVisible(selectedTab == 1)
    }
    DisposableEffect(Unit) {
        onDispose { controller.setMeasureVisible(false) }
    }

    MaterialTheme(colorScheme = darkColorScheme()) {
        Scaffold(
            topBar = {
                TopAppBar(title = { Text("RoomRelay S24 probe") })
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                PrimaryTabRow(selectedTabIndex = selectedTab) {
                    tabLabels.forEachIndexed { index, label ->
                        Tab(
                            selected = selectedTab == index,
                            onClick = { selectedTab = index },
                            text = { Text(label) },
                        )
                    }
                }
                when (selectedTab) {
                    0 -> CapabilityScreen(
                        state = state,
                        controller = controller,
                        onRequestCameraPermission = onRequestCameraPermission,
                    )
                    1 -> MeasureScreen(
                        state = state,
                        controller = controller,
                        onRequestCameraPermission = onRequestCameraPermission,
                    )
                    else -> ReportScreen(state = state, controller = controller)
                }
            }
        }
    }
}

@Composable
private fun CapabilityScreen(
    state: ProbeUiState,
    controller: ProbeController,
    onRequestCameraPermission: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Capability probe", style = MaterialTheme.typography.headlineSmall)
        Text("Device: ${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE})")
        Text("Android ${Build.VERSION.RELEASE} · API ${Build.VERSION.SDK_INT}")
        Text("App ${BuildConfig.VERSION_NAME} · version ${BuildConfig.VERSION_CODE}")
        Text("AR services: ${if (state.capability.arServicesInstalled) "installed" else "not detected"}")
        Text(
            "Version: ${state.capability.arServicesVersionName ?: "unknown"} " +
                "(code ${state.capability.arServicesVersionCode ?: "unknown"})",
        )
        Text(
            "Availability: ${state.capability.availability} " +
                "(${state.capability.availabilityPolls} checks" +
                if (state.capability.checkingAvailability) ", checking)" else ")",
        )
        Text("Camera permission: ${state.capability.cameraPermission}")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.capability.cameraPermission != "GRANTED") {
                Button(onClick = onRequestCameraPermission) { Text("Allow camera") }
                OutlinedButton(onClick = controller::openAppSettings) { Text("Open app settings") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = controller::requestInstall) { Text("Install / update AR services") }
            OutlinedButton(onClick = controller::refreshCapabilities) { Text("Re-run checks") }
        }
        state.capability.installRequestResult?.let {
            Text("Install request result: $it")
        }
        Text(
            "AR session: ${if (state.capability.sessionCreated) "created" else "not created"}",
            fontWeight = FontWeight.SemiBold,
        )
        state.capability.sessionErrorMessage?.let { ErrorText(it) }
        state.capability.configureErrorMessage?.let { ErrorText(it) }
        Text("Automatic depth supported: ${state.capability.depthAutomaticSupported ?: "unknown"}")
        Text("Raw depth only supported: ${state.capability.rawDepthOnlySupported ?: "unknown"}")
        state.capability.activeCameraConfig?.let {
            Text("Active camera: ${it.cameraId}, ${it.imageWidth}×${it.imageHeight}, ${it.fpsMin}–${it.fpsMax} fps")
        }
        Text("Back-facing camera configurations: ${state.capability.cameraConfigs.size}")
        state.capability.cameraConfigs.forEachIndexed { index, config ->
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Config ${index + 1}: camera ${config.cameraId}, ${config.facing}")
                    Text("Image ${config.imageWidth}×${config.imageHeight}; texture ${config.textureWidth}×${config.textureHeight}")
                    Text("FPS ${config.fpsMin}–${config.fpsMax}; depth ${config.depthSensorUsage}; stereo ${config.stereoCameraUsage}")
                }
            }
        }
        Text(
            "This probe keeps camera and depth data on-device. Only measurements and capability metadata are included in reports.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun MeasureScreen(
    state: ProbeUiState,
    controller: ProbeController,
    onRequestCameraPermission: () -> Unit,
) {
    var label by rememberSaveable { mutableStateOf("") }
    var tapeText by rememberSaveable { mutableStateOf("") }
    var surface by rememberSaveable { mutableStateOf(TrialSurface.FLOOR) }
    var nominalDistance by rememberSaveable { mutableStateOf(TrialDistance.NEAR_1M) }
    val measure = state.measure
    val tapeValid = parseTapeCm(tapeText) != null

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { controller.createGlView() },
            modifier = Modifier.fillMaxSize(),
            onRelease = controller::releaseGlView,
        )
        Column(
            Modifier.align(Alignment.TopCenter)
                .fillMaxWidth()
                .background(Color(0xCC101820))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(measure.status, color = Color.White, fontWeight = FontWeight.SemiBold)
            Text(
                "Tracking ${measure.trackingState}" +
                    if (measure.failureReason.isNotBlank()) " · ${measure.failureReason}" else "",
                color = Color.White,
            )
            Text(
                "Planes H ${measure.planesHorizontal} · V ${measure.planesVertical} · " +
                    "Depth ${measure.depthMode} · ${measure.fps} fps",
                color = Color.White,
            )
        }
        Column(
            Modifier.align(Alignment.BottomCenter)
                .fillMaxWidth()
                .heightIn(max = 430.dp)
                .background(Color(0xE6101820))
                .verticalScroll(rememberScrollState())
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Text(
                when {
                    !state.capability.sessionCreated -> "Open Capability and prepare AR services and camera permission."
                    !measure.hasBothAnchors -> "Tap a surface to set point A, then tap again to set point B."
                    else -> "Distance: ${formatMeters(measure.distanceMeters ?: 0.0)} " +
                        "(${com.roomrelay.app.core.formatCm((measure.distanceMeters ?: 0.0) * 100.0)})"
                },
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
            )
            if (measure.firstHitType != null || measure.secondHitType != null) {
                Text(
                    "A: ${measure.firstHitType ?: "—"} · B: ${measure.secondHitType ?: "—"}",
                    color = Color.White,
                )
            }
            if (state.capability.cameraPermission != "GRANTED") {
                Button(onClick = onRequestCameraPermission) { Text("Allow camera") }
            }
            measure.message.takeIf(String::isNotBlank)?.let { Text(it, color = Color(0xFFFFD180)) }
            Text("Surface", color = Color.White, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TrialSurface.values().forEach { option ->
                    FilterChip(
                        selected = surface == option,
                        onClick = { surface = option },
                        label = { Text(option.displayName()) },
                    )
                }
            }
            Text("Distance", color = Color.White, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TrialDistance.values().forEach { option ->
                    FilterChip(
                        selected = nominalDistance == option,
                        onClick = { nominalDistance = option },
                        label = { Text(option.displayName()) },
                    )
                }
            }
            OutlinedTextField(
                value = label,
                onValueChange = { label = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Measurement label") },
                placeholder = { Text("Floor · ~1 m · trial 1") },
                singleLine = true,
            )
            OutlinedTextField(
                value = tapeText,
                onValueChange = { tapeText = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Tape length (cm)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                singleLine = true,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    enabled =
                        measure.hasBothAnchors &&
                            tapeValid &&
                            measure.pairId != state.lastSavedPairId,
                    onClick = {
                        controller.saveTrial(tapeText, label, surface, nominalDistance)
                        tapeText = ""
                        label = ""
                    },
                ) {
                    Text("Save trial")
                }
                OutlinedButton(onClick = controller::resetPoints) { Text("Reset points") }
            }
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (state.sessionLogRunning) {
                    Button(onClick = controller::stopSessionLog) { Text("Stop log") }
                    Text(
                        "60-second log · ${((60 - state.sessionElapsedS).coerceAtLeast(0))}s remaining",
                        color = Color.White,
                    )
                } else {
                    Button(
                        enabled = state.capability.sessionCreated,
                        onClick = controller::startSessionLog,
                    ) {
                        Text("Start 60 s log")
                    }
                }
            }
            Text(
                "Protocol: " + PROTOCOL_CONDITIONS.joinToString(" · ") { (conditionSurface, distance) ->
                    val count = state.trials.count {
                        it.surface == conditionSurface && it.nominalDistance == distance
                    }
                    "${conditionSurface.displayName()} ${distance.displayName()} $count/$TRIALS_PER_CONDITION"
                },
                color = Color.White,
                style = MaterialTheme.typography.bodySmall,
            )
            if (state.trials.isNotEmpty()) {
                Text("Trials", color = Color.White, fontWeight = FontWeight.SemiBold)
                state.trials.forEach { trial ->
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("${trial.index}. ${trial.label}", color = Color.White)
                            Text(
                                "${trial.surface.displayName()} · ${trial.nominalDistance.displayName()}",
                                color = Color.White,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "AR ${formatMeters(trial.arcoreM)} · tape ${formatCm(trial.tapeCm)} · " +
                                    "${formatSignedCm(trial.errorCm)} (${formatSignedPct(trial.errorPct)})",
                                color = Color.White,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        TextButton(onClick = { controller.deleteTrial(trial.index) }) { Text("Delete") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ReportScreen(state: ProbeUiState, controller: ProbeController) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Probe report", style = MaterialTheme.typography.headlineSmall)
        Text("Measurements: ${state.trials.size}")
        Text("Measurement summary", fontWeight = FontWeight.SemiBold)
        summarizeTrials(state.trials).forEach { summary ->
            Text(
                "${summary.surface.displayName()} ${summary.nominalDistance.displayName()} · " +
                    "n=${summary.count} · mean ${formatSignedCm(summary.meanErrorCm)} · " +
                    "mean |cm| ${formatCm(summary.meanAbsErrorCm)} · " +
                    "max |cm| ${formatCm(summary.maxAbsErrorCm)} · " +
                    "mean |%| ${formatAbsPct(summary.meanAbsErrorPct)}",
            )
        }
        Text("Camera configs: ${state.capability.cameraConfigs.size}")
        Text("AR services: ${if (state.capability.arServicesInstalled) "installed" else "not detected"}")
        Text("Session log: ${state.sessionLog?.samples?.size ?: 0} populated seconds")
        state.sessionLog?.let {
            Text(
                "End: ${it.endReason} · target ${it.durationTargetS}s · " +
                    "depth ${it.depthMode} · thermal ${it.thermalStatusStart} → ${it.thermalStatusEnd}",
            )
            Text("Activity breaks: ${it.breaks.size}")
        }
        OutlinedTextField(
            value = state.notes,
            onValueChange = controller::updateNotes,
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp),
            label = { Text("Notes") },
            placeholder = { Text("Optional observations") },
        )
        Button(onClick = controller::exportAndShare) {
            Text("Export and share JSON")
        }
        state.reportFileName?.let { Text("Saved report: $it") }
        state.reportMessage.takeIf(String::isNotBlank)?.let { Text(it) }
        Text(
            "The JSON contains probe results only. Camera images and depth buffers are never saved or shared.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private fun formatAbsPct(percent: Double): String = String.format(Locale.ROOT, "%.1f %%", percent)

@Composable
private fun ErrorText(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error)
}
