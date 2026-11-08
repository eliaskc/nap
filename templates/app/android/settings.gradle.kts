// Every folder in apps/ with an app.json is an app: the module :apps:<slug>. The launcher
// (:launcher) is the one Android app Nap publishes, to Google Play's internal testing track.
// NapKit (:napkit) is Nap's client for Kotlin. The shared build of the apps is in build.gradle.kts.

pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "NapApps"

// The Android SDK: ANDROID_HOME, or local.properties (gitignored), which this writes once when
// the SDK is in its usual place.
val localProperties = file("local.properties")
if (System.getenv("ANDROID_HOME").isNullOrEmpty() && System.getenv("ANDROID_SDK_ROOT").isNullOrEmpty() &&
  !localProperties.exists()
) {
  val home = System.getProperty("user.home")
  listOf("$home/Library/Android/sdk", "$home/Android/Sdk").map(::File).firstOrNull { it.isDirectory }?.let {
    localProperties.writeText("sdk.dir=${it.absolutePath}\n")
  }
}

include(":launcher", ":napkit")

file("apps").listFiles()
  .orEmpty()
  .filter { File(it, "app.json").isFile }
  .sortedBy { it.name }
  .forEach { include(":apps:${it.name}") }
