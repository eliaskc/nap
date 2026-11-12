package nap.kit

import android.content.Context
import android.content.SharedPreferences
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

// NapKit: what a web page on Nap gets as window.nap, for the apps in this launcher. Nap serves
// it with the template and `scripts/napkit` updates it: never edit these files here.
//
//   val weave = Nap.site("weave")                     // a page on Nap, by its id
//   weave.db.collection("games", Game.serializer())   // its collections, live (nap.db.collection)
//   weave.channel("room")                             // its channels (nap.channel)
//   weave.fetch(url)                                  // nap.fetch
//   weave.notify("Elias wants to play")               // nap.notify
//   Nap.me(), Nap.people()                            // nap.me(), nap.people()
//   Nap.account                                       // the sign-in, shared by every app
//   NapPush                                           // notifications (Firebase Cloud Messaging)
//
// Apps cannot pass Cloudflare Access, so NapKit signs in once per launcher (the device flow) and
// sends that Nap token to /_nap/api. A page's data, channels, and live updates there are the same
// ones its web pages use, so the app and the site share them.
//
// State that Compose reads (documents, peers, the account) is snapshot state, changed on the
// main thread: composables that read it update with it. Suspending calls are main-safe.

/** The JSON NapKit reads and writes: unknown keys are ignored, missing nullable ones are null. */
val NapJson: Json = Json {
  ignoreUnknownKeys = true
  explicitNulls = false
  encodeDefaults = true
}

/** The Nap this launcher belongs to, and what is not about one page. */
object Nap {
  private const val DEFAULT_ORIGIN = "https://{{rootDomain}}"

  internal lateinit var context: Context
    private set
  internal val main = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  internal val http: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(20, TimeUnit.SECONDS)
      .readTimeout(20, TimeUnit.SECONDS)
      .writeTimeout(20, TimeUnit.SECONDS)
      .build()
  }
  /** WebSockets stay open without messages for a while: no read timeout. */
  internal val sockets: OkHttpClient by lazy { http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build() }
  internal val prefs: SharedPreferences by lazy { context.getSharedPreferences("nap.kit", Context.MODE_PRIVATE) }

  /**
   * This Nap, such as https://{{rootDomain}}. For a local Nap, start the launcher with
   * `adb shell am start -n <package>/nap.launcher.MainActivity -e nap-url http://10.0.2.2:1337`
   * (kept until `-e nap-url ''`).
   */
  val origin: String
    get() = prefs.getString("nap-url", null)?.takeIf { it.isNotEmpty() }?.trimEnd('/') ?: DEFAULT_ORIGIN

  /** The host of this Nap, for the person: "{{rootDomain}}". */
  val host: String get() = origin.substringAfter("://").substringBefore('/')

  /** The launcher's name, for sign-in requests. */
  val appName: String get() = context.applicationInfo.loadLabel(context.packageManager).toString()

  /** The sign-in: one for every app in the launcher. */
  val account: NapAccount = NapAccount()

  private val sites = mutableMapOf<String, NapSite>()

  /** Called by NapKit's starter with the app. */
  internal fun start(context: Context) {
    this.context = context.applicationContext
    account.load()
    NapPush.setUp(this.context)
  }

  /** Opens a URL in a Custom Tab, which shares the browser's sign-in to Access. */
  fun browse(url: String) {
    val tab = androidx.browser.customtabs.CustomTabsIntent.Builder().setShowTitle(true).build()
    val activity = Activities.front
    try {
      if (activity != null) {
        tab.launchUrl(activity, android.net.Uri.parse(url))
      } else {
        tab.intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        tab.launchUrl(context, android.net.Uri.parse(url))
      }
    } catch (_: android.content.ActivityNotFoundException) {
    }
  }

  /**
   * Testing overrides from the launcher's intent: `-e nap-url <url>` and `-e nap-token <token>`.
   * The launcher calls this with each intent it gets.
   */
  fun handleTestingExtras(extras: android.os.Bundle?) {
    extras ?: return
    extras.getString("nap-url")?.let { url ->
      if (url != prefs.getString("nap-url", null)) {
        forget()
        prefs.edit().putString("nap-url", url).apply()
      }
    }
    extras.getString("nap-token")?.takeIf { it.isNotEmpty() }?.let { account.adopt(it) }
  }

  /** A page on Nap by its id (a site's slug), with its collections, channels, fetch, and notify. */
  fun site(id: String): NapSite = sites.getOrPut(id) { NapSite(id) }

  /** The person signed in, with their name and look. Like nap.me(). */
  suspend fun me(): NapPerson = request("GET", api("me"), NapPerson.serializer())

  /** Everyone on this Nap, or only these emails, with their names and looks. Like nap.people(). */
  suspend fun people(emails: List<String>? = null): List<NapPerson> {
    val query = emails?.let { "?emails=" + encode(it.joinToString(",")) } ?: ""
    val result = request("GET", api("people") + query, JsonObject.serializer())
    return NapJson.decodeFromJsonElement(ListSerializer(NapPerson.serializer()), result["people"] ?: JsonObject(emptyMap()))
  }

  /** Whether this Nap sends notifications. Show what sends one only when it does. */
  suspend fun canNotify(): Boolean = try {
    val result = request("GET", api("notify"), JsonObject.serializer())
    (result["enabled"] as? JsonPrimitive)?.contentOrNull == "true"
  } catch (_: NapError) {
    false
  }

  /**
   * A notification from an app with no page of its own, to everyone else on this Nap with the
   * app or notifications on. `app` is its folder in apps/, so a tap opens it. Apps that play with
   * a site use `Nap.site(id).notify` instead. Returns how many people it went to.
   */
  suspend fun notify(title: String, body: String? = null, open: String? = null, app: String? = null): Int {
    val sent = request(
      "POST", api("notify"), JsonObject.serializer(),
      NapJson.encodeToJsonElement(NapNotification.serializer(), NapNotification(title, body, open, app)),
    )
    return (sent["sent"] as? JsonPrimitive)?.intOrNull ?: 0
  }

  /** Back in the foreground: sockets may be gone, so reconnect and catch up. */
  internal fun foreground() {
    sites.values.forEach { it.refresh() }
    NapPush.foreground()
  }

  /** Signing out: forget every page's data, and the copies on the device. */
  internal fun forget() {
    sites.values.forEach { it.forget() }
    copies().deleteRecursively()
  }

  /** Where collections keep their copies on the device. */
  internal fun copies(): File = File(context.cacheDir, "NapKit/$host")

  // HTTP

  /** /_nap/api/<path> on this Nap. */
  fun api(path: String): String = "$origin/_nap/api/$path"

  /**
   * A request with the Nap token. Fails with a NapError when it cannot reach Nap (status 0); the
   * status is not checked: see [check].
   */
  suspend fun send(
    method: String,
    url: String,
    body: ByteArray? = null,
    contentType: String? = "application/json",
    headers: Map<String, String> = emptyMap(),
    auth: Boolean = true,
  ): NapResponse {
    val builder = Request.Builder().url(url)
    headers.forEach { (key, value) -> builder.header(key, value) }
    if (auth) account.token?.let { builder.header("authorization", "Bearer $it") }
    val requestBody = body?.toRequestBody(contentType?.toMediaTypeOrNull())
      ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null
    builder.method(method, requestBody)
    return withContext(Dispatchers.IO) {
      try {
        http.newCall(builder.build()).execute().use { NapResponse(it.code, it.headers, it.body.bytes()) }
      } catch (e: IOException) {
        throw NapError(e.message ?: "Could not reach $host", status = 0)
      } catch (e: IllegalArgumentException) {
        throw NapError(e.message ?: "Bad URL", status = 0)
      }
    }
  }

  /** A JSON request: sends `body`, checks the status, and decodes the answer as `T`. */
  suspend fun <T> request(
    method: String,
    url: String,
    deserializer: DeserializationStrategy<T>,
    body: JsonElement? = null,
    headers: Map<String, String> = emptyMap(),
    auth: Boolean = true,
  ): T {
    val data = body?.let { NapJson.encodeToString(JsonElement.serializer(), it).encodeToByteArray() }
    val response = send(method, url, data, headers = headers, auth = auth)
    check(response)
    return try {
      NapJson.decodeFromString(deserializer, response.text())
    } catch (e: IllegalArgumentException) {
      throw NapError("Nap answered something unexpected: ${e.message}", status = response.status)
    }
  }

  /** Throws the NapError for a failed response. A lost sign-in signs out. */
  fun check(response: NapResponse) {
    if (response.status in 200..299) return
    val error = napError(response.status, response.text())
    if (response.status == 401) account.refused(error)
    throw error
  }

  internal fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}

/** The NapError for a failed response's status and body. */
internal fun napError(status: Int, body: String): NapError {
  val failure = runCatching { NapJson.parseToJsonElement(body).jsonObject }.getOrNull()
  fun field(name: String) = (failure?.get(name) as? JsonPrimitive)?.contentOrNull
  val document = failure?.get("document")?.let {
    runCatching { NapJson.decodeFromJsonElement(NapDocument.serializer(JsonElement.serializer()), it) }.getOrNull()
  }
  return NapError(
    message = field("error_description") ?: field("error") ?: "Nap answered $status",
    code = field("code"),
    status = status,
    document = document,
  )
}

/** An answer from Nap. */
class NapResponse(val status: Int, private val headers: Headers, val body: ByteArray) {
  fun header(name: String): String? = headers[name]
  fun text(): String = body.decodeToString()
}

@Serializable
internal data class NapNotification(
  val title: String,
  val body: String? = null,
  val open: String? = null,
  val app: String? = null,
  val skip: List<String>? = null,
  val only: List<String>? = null,
  val tag: String? = null,
  val quiet: Boolean? = null,
  val image: String? = null,
)

/**
 * What Nap answered when a request failed. `status` is the HTTP status (0: Nap could not be
 * reached); `document` is the current version when a write lost to someone else's (409).
 */
class NapError(
  override val message: String,
  val code: String? = null,
  val status: Int,
  val document: NapDocument<JsonElement>? = null,
) : Exception(message) {
  /** The sign-in is gone: NapKit has signed out. */
  val signedOut: Boolean get() = status == 401 && code == "invalid_token"
  /** The person must open Nap in a browser once before the app may use it. */
  val inactive: Boolean get() = status == 401 && code == "inactive"
}

/** Someone on Nap, with the look the web draws them with. */
@Serializable
data class NapPerson(
  val email: String,
  val name: String,
  val shape: String? = null,
  val color: String? = null,
) {
  val firstName: String get() = name.split(" ").firstOrNull { it.isNotEmpty() } ?: name
}
