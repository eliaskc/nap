package nap.kit

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * Notifications on this phone: Nap's (nap.notify from pages and apps) arrive through Firebase
 * Cloud Messaging once someone is signed in and allows them. The launcher starts it (with
 * [NapPushStarter]) and opens what a tap asks for ([opened]). Its properties are Compose state.
 *
 * The Firebase project is the Nap's, not the repo's: NapKit asks Nap for it (push/android) and
 * starts Firebase with it, and keeps it so that Firebase starts with the app next time, before a
 * notification can arrive.
 */
object NapPush {
  /** The notification channel every Nap notification uses. */
  const val CHANNEL = "nap"

  /** Whether this Nap sends notifications to Android: null until known. Show notification settings only when it does. */
  var enabled: Boolean? by mutableStateOf(null)
    private set
  /** Whether this phone gets notifications: null until known. */
  var allowed: Boolean? by mutableStateOf(null)
    private set
  /** What the last tapped notification opens: the launcher clears it once it has. */
  var opened: NapOpen? by mutableStateOf(null)

  private val prefs get() = Nap.prefs

  /** The token this phone registered with Nap, to unregister on sign-out. */
  private var lastToken: String?
    get() = prefs.getString("push-token", null)
    set(value) = prefs.edit().apply { if (value == null) remove("push-token") else putString("push-token", value) }.apply()

  /** Called by Nap.start: the channel, and Firebase when this Nap has set it up before. */
  internal fun setUp(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT))
    stored()?.let { firebase(context, it) }
  }

  /**
   * On Naps that send notifications: starts Firebase, asks to allow notifications (once, on
   * Android 13 and later: `ask` shows the system's question and calls [answered]), and registers
   * this phone. Only while someone is signed in. [NapPushStarter] calls it.
   */
  suspend fun start(ask: (() -> Unit)? = null) {
    if (!Nap.account.signedIn) return
    val config = try {
      FirebaseConfig.parse(Nap.request("GET", Nap.api("push/android"), JsonObject.serializer()))
    } catch (e: CancellationException) {
      throw e
    } catch (_: NapError) {
      // Not on this Nap (an older one answers 404), or offline: off until the next start.
      enabled = false
      return
    }
    enabled = config != null
    if (config == null) return
    if (!firebase(Nap.context, config)) {
      // Firebase is running with another project's settings: the next launch uses the new ones.
      store(config)
      return
    }
    store(config)
    FirebaseMessaging.getInstance().isAutoInitEnabled = true
    when {
      permitted() -> {
        allowed = true
        register()
      }
      ask != null && Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("push-asked", false) -> {
        prefs.edit().putBoolean("push-asked", true).apply()
        ask()
      }
      else -> allowed = false
    }
  }

  /** The answer to the question [start] asked. */
  fun answered(granted: Boolean) {
    allowed = granted
    if (granted) Nap.main.launch { register() }
  }

  /** Back in the foreground: notifications may have been turned on or off in Settings. */
  internal fun foreground() {
    if (enabled != true || !Nap.account.signedIn) return
    val now = permitted()
    if (now == allowed) return
    allowed = now
    if (now) Nap.main.launch { register() }
  }

  /**
   * A notification to this person's own phones and browsers, to check they arrive. Returns how
   * many devices it went to.
   */
  suspend fun test(): Int {
    val sent = Nap.request("POST", Nap.api("push/test"), JsonObject.serializer())
    return (sent["devices"] as? JsonPrimitive)?.intOrNull ?: 0
  }

  /** The system's notification settings for this app, where people turn them on or off. */
  fun openSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
      .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
  }

  /**
   * The launcher calls this with each intent it gets: a tapped notification sets [opened].
   * Returns whether it was one.
   */
  fun handle(intent: Intent?): Boolean {
    // From Recents, Android repeats the intent that started the task: not a tap any more.
    if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
    val extras = intent.extras ?: return false
    val open = NapOpen.from { extras.getString(it) } ?: return false
    opened = open
    return true
  }

  /** Whether the system shows this app's notifications. */
  private fun permitted(): Boolean {
    val context = Nap.context
    if (Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false
    return context.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
  }

  // Registration

  private suspend fun register() {
    if (FirebaseApp.getApps(Nap.context).isEmpty()) return
    val token = try {
      FirebaseMessaging.getInstance().token.await()
    } catch (e: CancellationException) {
      throw e
    } catch (_: Exception) {
      // No Google Play services, or offline: the next launch tries again.
      return
    }
    register(token)
  }

  /** Firebase gave this phone a new token. */
  internal fun newToken(token: String) {
    Nap.main.launch {
      if (Nap.account.signedIn && enabled != false && permitted()) register(token)
    }
  }

  private suspend fun register(token: String) {
    if (!Nap.account.signedIn) return
    val body = buildJsonObject {
      put("platform", "android")
      put("token", token)
      put("label", "${Nap.appName} on ${Build.MODEL}")
    }
    try {
      Nap.request("POST", Nap.api("push/devices"), JsonObject.serializer(), body)
      lastToken = token
    } catch (e: CancellationException) {
      throw e
    } catch (_: NapError) {
      // Notifications off on this Nap (404 notifications_off), or offline: the next launch tries again.
    }
  }

  /** Signing out: this phone stops getting the person's notifications. */
  internal fun signedOut(token: String) {
    allowed = null
    enabled = null
    val device = lastToken ?: return
    lastToken = null
    val body = buildJsonObject {
      put("platform", "android")
      put("token", device)
    }.toString().encodeToByteArray()
    Nap.main.launch {
      try {
        Nap.send("DELETE", Nap.api("push/devices"), body, headers = mapOf("authorization" to "Bearer $token"), auth = false)
      } catch (_: NapError) {
      }
    }
  }

  // Firebase

  /**
   * Starts Firebase with the Nap's project, once per process. False when it is running already
   * with another project's settings.
   */
  private fun firebase(context: Context, config: FirebaseConfig): Boolean {
    val running = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
    if (running != null) return running.options.applicationId == config.appId && running.options.projectId == config.projectId
    return runCatching {
      FirebaseApp.initializeApp(
        context,
        FirebaseOptions.Builder()
          .setApiKey(config.apiKey)
          .setApplicationId(config.appId)
          .setProjectId(config.projectId)
          .setGcmSenderId(config.senderId)
          .build(),
      )
    }.isSuccess
  }

  private fun stored(): FirebaseConfig? =
    prefs.getString("push-firebase", null)?.let { runCatching { NapJson.decodeFromString(FirebaseConfig.serializer(), it) }.getOrNull() }

  private fun store(config: FirebaseConfig) {
    prefs.edit().putString("push-firebase", NapJson.encodeToString(FirebaseConfig.serializer(), config)).apply()
  }

  // Notifications while the app is open

  /**
   * A notification that arrived while the app was in front (Android shows the others itself):
   * shown the same way, and a tap opens the launcher with the same extras.
   */
  internal fun show(context: Context, message: RemoteMessage) {
    val data = message.data
    val title = message.notification?.title ?: data["title"] ?: return
    val body = message.notification?.body ?: data["body"]
    val source = data["source"] ?: ""
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    data["url"]?.let { launch.putExtra("url", it) }
    launch.putExtra("source", source)
    val tap = PendingIntent.getActivity(
      context, source.hashCode(), launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.nap_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setContentIntent(tap)
      .apply { data["subtitle"]?.takeIf { it.isNotEmpty() }?.let { setSubText(it) } }
      .build()
    // The same tag and id as the ones Android shows, so a newer one from the same place replaces it.
    runCatching { context.getSystemService(NotificationManager::class.java).notify(source.ifEmpty { null }, 0, notification) }
  }
}

/**
 * Starts notifications once someone is signed in: asks to allow them, and registers this phone.
 * The launcher puts it in its content, once.
 */
@Composable
fun NapPushStarter() {
  val signedIn = Nap.account.signedIn
  val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { NapPush.answered(it) }
  LaunchedEffect(signedIn) {
    if (signedIn) NapPush.start { ask.launch(Manifest.permission.POST_NOTIFICATIONS) }
  }
}

/**
 * What a tapped notification asks to open. `source` is where it came from: "site:<id>" for a
 * page (the launcher opens the app whose app.json names that site), "app:<folder>" for an app,
 * "app" or "test" otherwise. `url` is its page, for the browser when no app is for it.
 */
data class NapOpen(val url: String?, val source: String) {
  /** The page id for "site:<id>". */
  val site: String? get() = source.removePrefix("site:").takeIf { source.startsWith("site:") && it.isNotEmpty() }
  /** The app's folder for "app:<folder>". */
  val app: String? get() = source.removePrefix("app:").takeIf { source.startsWith("app:") && it.isNotEmpty() }

  companion object {
    /** From a notification's data (an intent's extras): null when it is not one of Nap's. */
    fun from(extra: (String) -> String?): NapOpen? {
      val source = extra("source")
      val url = extra("url")?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
      if (source == null && url == null) return null
      return NapOpen(url, source ?: "")
    }
  }
}

/** The Firebase project a Nap sends notifications with, from push/android. */
@Serializable
internal data class FirebaseConfig(val apiKey: String, val appId: String, val projectId: String, val senderId: String) {
  companion object {
    /** Null when the Nap does not send notifications to Android. */
    fun parse(json: JsonObject): FirebaseConfig? {
      if ((json["enabled"] as? JsonPrimitive)?.booleanOrNull != true) return null
      val firebase = json["firebase"] ?: return null
      return runCatching { NapJson.decodeFromJsonElement(serializer(), firebase) }.getOrNull()
    }
  }
}

/**
 * Firebase Cloud Messaging for NapKit (declared in its manifest): new tokens, and notifications
 * that arrive while the app is in front.
 */
class NapMessagingService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    NapPush.newToken(token)
  }

  override fun onMessageReceived(message: RemoteMessage) {
    NapPush.show(applicationContext, message)
  }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
  addOnCompleteListener { task ->
    val error = task.exception
    when {
      error != null -> continuation.resumeWithException(error)
      task.isCanceled -> continuation.cancel()
      else -> continuation.resume(task.result)
    }
  }
}
