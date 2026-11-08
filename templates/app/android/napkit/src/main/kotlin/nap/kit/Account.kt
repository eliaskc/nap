package nap.kit

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/**
 * Who is signed in, and the sign-in itself: Nap's device flow. The launcher shows it; apps read
 * `Nap.account.signedIn` and can put a [NapSignInButton] where they need someone signed in.
 * Its properties are Compose state.
 */
class NapAccount internal constructor() {
  var token: String? by mutableStateOf(null)
    private set
  var email: String? by mutableStateOf(null)
    private set
  var name: String? by mutableStateOf(null)
    private set
  var signingIn: Boolean by mutableStateOf(false)
    private set
  /** The code the approval page shows while signing in, to compare. */
  var userCode: String? by mutableStateOf(null)
    private set
  /** Why the last sign-in or request failed, for the person. */
  var error: String? by mutableStateOf(null)

  private var signInJob: Job? = null

  val signedIn: Boolean get() = token != null
  /** The signed-in person's name, or their email. */
  val displayName: String get() = name ?: email ?: ""

  internal fun load() {
    token = Vault.read("token")
    email = Vault.read("email")
    name = Vault.read("name")
  }

  /** Signs in with a token from elsewhere, such as `-e nap-token <token>` when testing. */
  fun adopt(token: String) {
    this.token = token
    Vault.write("token", token)
    Nap.main.launch { loadMe() }
  }

  /** Signs out: forgets the token, and every page's data and copies on the device. */
  fun signOut() {
    token = null
    email = null
    name = null
    listOf("token", "email", "name").forEach { Vault.write(it, null) }
    Nap.forget()
  }

  /** A request was refused: a lost token signs out; a paused one asks to open Nap in a browser. */
  internal fun refused(refusal: NapError) {
    when (refusal.code) {
      "invalid_token" -> {
        signOut()
        error = "Signed out. Sign in again."
      }
      "inactive" -> error = "Open ${Nap.host} in a browser once, then try again."
    }
  }

  /** The person's name, for apps that show it. */
  suspend fun loadMe() {
    val me = try { Nap.me() } catch (_: NapError) { return }
    email = me.email
    name = me.name
    Vault.write("email", me.email)
    Vault.write("name", me.name)
  }

  /** Starts signing in, or does nothing if a sign-in is under way. */
  fun startSignIn() {
    if (signingIn) return
    signInJob = Nap.main.launch { signIn() }
  }

  fun cancelSignIn() {
    signInJob?.cancel()
  }

  /** The device flow: get a code, show the approval page, and poll for the token. */
  suspend fun signIn() {
    if (signingIn) return
    signingIn = true
    error = null
    try {
      val start = Nap.request(
        "POST", Nap.api("auth/device"), JsonObject.serializer(),
        buildJsonObject { put("client", "${Nap.appName} for Android") }, auth = false,
      )
      fun field(name: String) = (start[name] as? JsonPrimitive)?.contentOrNull
      val deviceCode = field("device_code") ?: throw NapError("Nap did not start the sign-in", status = 0)
      userCode = field("user_code")
      field("verification_uri_complete")?.let { present(it) }
      val interval = maxOf(2.0, (start["interval"] as? JsonPrimitive)?.doubleOrNull ?: 5.0).seconds
      val deadline = TimeSource.Monotonic.markNow() + 10.minutes
      while (deadline.hasNotPassedNow()) {
        delay(interval)
        val body = buildJsonObject { put("device_code", deviceCode) }.toString().encodeToByteArray()
        val response = Nap.send("POST", Nap.api("auth/token"), body, auth = false)
        val result = runCatching { NapJson.parseToJsonElement(response.text()) as JsonObject }.getOrNull()
        fun answer(name: String) = (result?.get(name) as? JsonPrimitive)?.contentOrNull
        val token = answer("token")
        if (token != null) {
          this.token = token
          email = answer("email")
          Vault.write("token", token)
          Vault.write("email", email)
          comeBack()
          loadMe()
          return
        }
        when (val failure = answer("error")) {
          "authorization_pending", "slow_down" -> continue
          "access_denied" -> {
            error = "Sign-in was denied."
            return
          }
          else -> {
            error = "Sign-in failed (${failure ?: response.status})."
            return
          }
        }
      }
      error = "Sign-in timed out."
    } catch (e: CancellationException) {
      throw e
    } catch (e: NapError) {
      error = e.message
    } finally {
      signingIn = false
      userCode = null
    }
  }

  /**
   * The approval page, in a Custom Tab that shares the browser's cookies, so Access is usually
   * signed in already. It never calls back: polling notices the approval and comes back.
   */
  private fun present(url: String) {
    val activity = Activities.front
    val intent = CustomTabsIntent.Builder().setShowTitle(true).build()
    try {
      if (activity != null) {
        intent.launchUrl(activity, Uri.parse(url))
      } else {
        intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        intent.launchUrl(Nap.context, Uri.parse(url))
      }
    } catch (_: ActivityNotFoundException) {
      error = "No browser to sign in with. Open $url"
    }
  }

  /** Signed in: close the Custom Tab by bringing the app's own activity back to the front. */
  private fun comeBack() {
    val launch = Nap.context.packageManager.getLaunchIntentForPackage(Nap.context.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    runCatching { Nap.context.startActivity(launch) }
  }
}

/** Sign in to Nap, with the code to compare and a way to cancel while it waits. */
@Composable
fun NapSignInButton(modifier: Modifier = Modifier, label: String = "Sign in to ${Nap.host}") {
  val account = Nap.account
  Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
    if (account.signingIn) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(account.userCode?.let { "Approve code $it" } ?: "Signing in…")
        TextButton(onClick = { account.cancelSignIn() }) { Text("Cancel") }
      }
    } else {
      Button(onClick = { account.startSignIn() }) { Text(label) }
    }
    account.error?.let {
      Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
