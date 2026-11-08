import groovy.json.JsonSlurper

// The launcher: the one Android app Nap publishes, to Google Play's internal testing track. It
// holds every app in apps/ (their modules, and a registry generated from their app.json).
// Nap signs the release bundle with the Play upload key and sets versionCode when it publishes:
// never add a signingConfig here.

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.compose)
}

/** The launcher's name on the home screen. */
val displayName = "{{title}}"

val apps = rootProject.findProject(":apps")?.childProjects?.values.orEmpty().sortedBy { it.name }

android {
  namespace = "nap.launcher"
  compileSdk = libs.versions.compileSdk.get().toInt()
  defaultConfig {
    // The instance's Play package: Nap publishes under this id, so never change it.
    applicationId = "{{androidPackage}}"
    minSdk = libs.versions.minSdk.get().toInt()
    targetSdk = libs.versions.targetSdk.get().toInt()
    versionCode = 1
    versionName = "1.0"
    manifestPlaceholders["appName"] = displayName
  }
  buildTypes {
    release {
      isMinifyEnabled = false
    }
  }
  buildFeatures { compose = true }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

dependencies {
  implementation(project(":napkit"))
  apps.forEach { implementation(project(it.path)) }
  implementation(platform(libs.compose.bom))
  implementation(libs.compose.ui)
  implementation(libs.compose.material3)
  implementation(libs.compose.icons)
  implementation(libs.activity.compose)
}

/** Writes Registry.kt: every app in apps/, with its title, summary, site, and AppView. */
abstract class GenerateRegistry : DefaultTask() {
  @get:InputFiles
  @get:PathSensitive(PathSensitivity.RELATIVE)
  abstract val manifests: ConfigurableFileCollection

  @get:OutputDirectory
  abstract val outputDir: DirectoryProperty

  @TaskAction
  fun generate() {
    fun kotlin(value: Any?) = (value as? String ?: "")
      .replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "\\$").replace("\n", "\\n")
    val entries = manifests.files.sortedBy { it.parentFile.name }.map { file ->
      @Suppress("UNCHECKED_CAST")
      val app = JsonSlurper().parse(file) as Map<String, Any?>
      val slug = file.parentFile.name
      val title = kotlin(app["title"]).ifEmpty { slug }
      "  AppEntry(\"$slug\", \"$title\", \"${kotlin(app["summary"])}\", \"${kotlin(app["site"])}\") " +
        "{ nap.apps.${slug.replace('-', '_')}.AppView() },"
    }
    val dir = outputDir.get().asFile.resolve("nap/launcher")
    dir.mkdirs()
    dir.resolve("Registry.kt").writeText(
      "// Generated from apps/*/app.json by :launcher:generateRegistry. Do not edit.\n" +
        "package nap.launcher\n\n" +
        "internal val registry: List<AppEntry> = listOf(\n" + entries.joinToString("\n") + "\n)\n",
    )
  }
}

val generateRegistry = tasks.register<GenerateRegistry>("generateRegistry") {
  manifests.from(apps.map { it.projectDir.resolve("app.json") })
  outputDir.set(layout.buildDirectory.dir("generated/registry"))
}

androidComponents {
  onVariants { variant ->
    variant.sources.kotlin?.addGeneratedSourceDirectory(generateRegistry, GenerateRegistry::outputDir)
  }
}
