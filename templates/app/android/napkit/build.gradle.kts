// NapKit: window.nap for Kotlin. Nap serves it with the template, and scripts/napkit replaces
// this folder with the one Nap serves: never edit it here.
plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.compose)
  alias(libs.plugins.kotlin.serialization)
}

android {
  namespace = "nap.kit"
  compileSdk = libs.versions.compileSdk.get().toInt()
  defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
  buildFeatures { compose = true }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

dependencies {
  api(platform(libs.compose.bom))
  api(libs.compose.runtime)
  api(libs.coroutines.android)
  api(libs.serialization.json)
  implementation(libs.compose.material3)
  implementation(libs.okhttp)
  implementation(libs.browser)
  testImplementation(libs.junit)
}
