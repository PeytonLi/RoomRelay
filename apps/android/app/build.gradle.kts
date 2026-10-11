import java.net.URI
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

/**
 * Downloads the pinned EfficientDet-Lite0 int8 detector model into the
 * generated assets directory. Cacheable: skipped when the existing file hash
 * matches, and the build FAILS on a hash mismatch so a substituted or corrupt
 * model can never ship silently.
 */
abstract class DownloadDetectorModelTask : DefaultTask() {
    @get:Input
    abstract val url: Property<String>

    @get:Input
    abstract val sha256: Property<String>

    @get:Input
    abstract val fileName: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun download() {
        val dir = outputDir.get().asFile
        dir.mkdirs()
        val target = File(dir, fileName.get())
        val expected = sha256.get().lowercase()
        if (target.exists() && hashOf(target) == expected) {
            logger.lifecycle("Detector model already present with matching SHA-256")
            return
        }
        target.delete()
        URI(url.get()).toURL().openStream().use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        }
        val actual = hashOf(target)
        if (actual != expected) {
            target.delete()
            throw GradleException(
                "Detector model hash mismatch: expected $expected, got $actual",
            )
        }
        logger.lifecycle("Downloaded detector model ${fileName.get()} (sha256 $actual)")
    }

    private fun hashOf(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

val downloadDetectorModel = tasks.register<DownloadDetectorModelTask>("downloadDetectorModel") {
    url.set("https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite")
    sha256.set("0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb")
    fileName.set("efficientdet_lite0.tflite")
    outputDir.set(layout.buildDirectory.dir("generated/detectorModel/assets"))
}

android {
    namespace = "com.roomrelay.app"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.roomrelay.app"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.2.0-t007"

        // Empty default keeps sync fully inert; set -Proomrelay.apiBaseUrl to point at a server.
        buildConfigField(
            "String",
            "ROOMRELAY_API_BASE_URL",
            "\"${providers.gradleProperty("roomrelay.apiBaseUrl").orElse("").get()}\"",
        )
    }

    androidComponents {
        onVariants { variant ->
            variant.sources.assets?.addGeneratedSourceDirectory(
                downloadDetectorModel,
                DownloadDetectorModelTask::outputDir,
            )
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    lint {
        abortOnError = true
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.arcore)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.mediapipe.tasks.vision)
    implementation(libs.okhttp)

    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.mockwebserver)
}
