import com.android.build.api.dsl.LibraryExtension
import groovy.json.JsonSlurper

// The build every app in apps/ shares, so an app folder needs only app.json and its Kotlin.
// Each app is an Android library, nap.apps.<slug> (hyphens become underscores), with Compose,
// kotlinx.serialization, and NapKit. Its src/main/AndroidManifest.xml, if it has one, is merged
// into the launcher's: that is where <uses-permission> goes.
//
// app.json:
// - "title", "summary": the launcher's list.
// - "site": the page on Nap the app plays with (its id).
// - "dependencies": Maven libraries the app needs, as "group:artifact:version", such as
//   ["io.coil-kt.coil3:coil-compose:3.3.0"]. From Google's Maven or Maven Central.

plugins {
  alias(libs.plugins.android.application) apply false
  alias(libs.plugins.android.library) apply false
  alias(libs.plugins.kotlin.compose) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

findProject(":apps")?.subprojects?.forEach { app ->
  val slug = app.name
  val manifest = app.file("app.json")
  app.apply(plugin = "com.android.library")
  app.apply(plugin = "org.jetbrains.kotlin.plugin.compose")
  app.apply(plugin = "org.jetbrains.kotlin.plugin.serialization")

  app.extensions.configure<LibraryExtension> {
    namespace = "nap.apps." + slug.replace('-', '_')
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    buildFeatures { compose = true }
    compileOptions {
      sourceCompatibility = JavaVersion.VERSION_17
      targetCompatibility = JavaVersion.VERSION_17
    }
  }

  @Suppress("UNCHECKED_CAST")
  val libraries = (JsonSlurper().parse(manifest) as Map<String, Any?>)["dependencies"] as? List<String> ?: emptyList()

  app.dependencies {
    add("implementation", project(":napkit"))
    add("implementation", platform(libs.compose.bom))
    add("implementation", libs.compose.ui)
    add("implementation", libs.compose.foundation)
    add("implementation", libs.compose.material3)
    add("implementation", libs.compose.icons)
    add("implementation", libs.compose.tooling.preview)
    add("debugImplementation", libs.compose.tooling)
    libraries.forEach { add("implementation", it) }
  }
}
