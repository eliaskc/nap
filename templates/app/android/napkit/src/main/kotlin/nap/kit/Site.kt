package nap.kit

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.time.Instant
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * A page on Nap, as its web pages see it: `Nap.site("weave")`. Its collections and channels are
 * the ones its web pages use.
 */
class NapSite internal constructor(val id: String) {
  /** Whether the live socket is open: changes arrive at once. Otherwise NapKit polls. */
  var live: Boolean by mutableStateOf(false)
    private set

  private val collections = mutableMapOf<String, NapCollectionBase>()
  private var socket: WebSocket? = null
  private var pollJob: Job? = null
  private var pingJob: Job? = null
  private var retries = 0
  private var rtcCache: NapRtc? = null

  /** /_nap/api/naps/<id>/<path>. */
  fun url(path: String): String = Nap.api("naps/${Nap.encode(id)}/$path")

  /** The page's collections, like nap.db on the web. */
  val db: NapDB get() = NapDB(this)

  /** The page's files (photos and other blobs), like nap.files on the web. */
  val files: NapFiles get() = NapFiles(this)

  /** A channel of the page, like nap.channel(name), with any JSON as messages. Call `leave()` when done. */
  fun channel(name: String): NapChannel<JsonElement> = NapChannel(this, name, JsonElement.serializer())

  /**
   * A channel whose messages are one serializable type, such as a sealed class of a game's
   * messages: `site.channel("room", GameMessage.serializer())`. Messages that do not decode as
   * it are dropped.
   */
  fun <M> channel(name: String, messages: KSerializer<M>): NapChannel<M> = NapChannel(this, name, messages)

  /**
   * Watches a channel without joining it: `peers` and their presence stay live, but nobody sees
   * this device and it cannot send. For showing who is in a lobby. Call `leave()` when done.
   */
  fun watch(name: String): NapChannel<JsonElement> = NapChannel(this, name, JsonElement.serializer(), isWatching = true)

  /**
   * ICE servers for WebRTC between people on this page: STUN, and TURN relays with short-lived
   * credentials when the Nap has a TURN key. Kept until shortly before they expire.
   */
  suspend fun rtc(): NapRtc {
    rtcCache?.let { cache ->
      if (cache.expiresAt?.let { it.isAfter(Instant.now().plusSeconds(600)) } == true) return cache
    }
    return NapRtc.parse(Nap.request("GET", url("rtc"), JsonObject.serializer())).also { rtcCache = it }
  }

  /**
   * Fetches a URL through Nap, for APIs the page lists in its nap.json ("fetch"). Like nap.fetch.
   * The answer is the API's, whatever its status.
   */
  suspend fun fetch(
    target: String,
    method: String = "GET",
    headers: Map<String, String> = emptyMap(),
    body: ByteArray? = null,
  ): NapResponse {
    val sent = if (headers.isEmpty()) emptyMap() else mapOf(
      "x-nap-fetch-headers" to JsonObject(headers.mapValues { JsonPrimitive(it.value) }).toString(),
    )
    val type = headers.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value
    val response = Nap.send(method, url("fetch") + "?url=" + Nap.encode(target), body, type, sent)
    if (response.header("x-nap-fetch") == null) {
      Nap.check(response)
      throw NapError("Nap fetch failed", status = response.status)
    }
    return response
  }

  /**
   * A notification to everyone else who can see this page, on their phones and in browsers with
   * notifications on. Never to the sender. `open` is where a tap goes: a path on the page's site
   * (default its home) or a URL on this Nap. `skip`: emails of people to leave out too; `only`:
   * the only people it may go to. `tag`: a newer one with the same tag replaces it on every
   * device. `quiet`: no sound or banner, only in the list. `image`: the id of an image file of
   * this page (`files.upload`), shown with it. Returns how many people it went to.
   */
  suspend fun notify(
    title: String,
    body: String? = null,
    open: String? = null,
    skip: List<String> = emptyList(),
    only: List<String>? = null,
    tag: String? = null,
    quiet: Boolean = false,
    image: String? = null,
  ): Int {
    val sent = Nap.request(
      "POST", url("notify"), JsonObject.serializer(),
      NapJson.encodeToJsonElement(
        NapNotification.serializer(),
        NapNotification(title, body, open, skip = skip.ifEmpty { null }, only = only, tag = tag, quiet = quiet.takeIf { it }, image = image),
      ),
    )
    return (sent["sent"] as? JsonPrimitive)?.intOrNull ?: 0
  }

  /** One of the Nap's extensions (instance/extensions/<name>), for its Kotlin client. */
  fun extensionKit(name: String): NapExtensionKit = NapExtensionKit(this, name)

  // Live updates

  @Suppress("UNCHECKED_CAST")
  internal fun <T> collection(name: String, serializer: KSerializer<T>, keepCopy: Boolean): NapCollection<T> {
    val key = "$name|${serializer.descriptor.serialName}"
    val collection = collections.getOrPut(key) { NapCollection(this, name, serializer) } as NapCollection<T>
    if (keepCopy) collection.keepCopy()
    return collection
  }

  private val watched get() = collections.values.filter { it.watched }

  /**
   * A collection started watching: connect, and poll as a safety net (often while the socket is
   * down, rarely while it is up), like the web client.
   */
  internal fun watching() {
    connect()
    if (pollJob != null) return
    pollJob = Nap.main.launch {
      while (isActive) {
        delay(if (live) 30.seconds else 3.seconds)
        watched.forEach { it.poll() }
      }
    }
  }

  /** A collection stopped watching: with none left, close the socket. */
  internal fun unwatched() {
    if (watched.isNotEmpty()) return
    pollJob?.cancel()
    pollJob = null
    disconnect()
  }

  /** Reconnects now and catches up, e.g. after the app was in the background. */
  fun refresh() {
    if (watched.isEmpty()) return
    disconnect()
    retries = 0
    connect()
    Nap.main.launch { watched.forEach { it.poll() } }
  }

  /** Signed out: forget every collection and its copy on the device. */
  internal fun forget() {
    collections.values.forEach { it.forget() }
    unwatched()
    rtcCache = null
  }

  private fun disconnect() {
    pingJob?.cancel()
    socket?.close(1001, null)
    socket = null
    live = false
  }

  private fun connect() {
    val token = Nap.account.token
    if (socket != null || token == null) return
    val request = Request.Builder().url(url("live")).header("authorization", "Bearer $token").build()
    lateinit var ws: WebSocket
    ws = Nap.sockets.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Nap.main.launch {
          if (socket !== ws) return@launch
          live = true
          retries = 0
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (text == "pong") return
        Nap.main.launch { if (socket === ws) receive(text) }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        Nap.main.launch { closed(ws) }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Nap.main.launch { closed(ws) }
      }
    })
    socket = ws
    // A ping every 30 seconds keeps it open.
    pingJob?.cancel()
    pingJob = Nap.main.launch {
      while (isActive && socket === ws) {
        delay(30.seconds)
        ws.send("ping")
      }
    }
  }

  private fun receive(text: String) {
    val message = runCatching { NapJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
    if ((message["type"] as? JsonPrimitive)?.contentOrNull != "change") return
    val name = (message["collection"] as? JsonPrimitive)?.contentOrNull
    collections.values.filter { it.name == name }.forEach { it.receive(message) }
  }

  private fun closed(ws: WebSocket) {
    if (socket !== ws) return
    pingJob?.cancel()
    socket = null
    live = false
    if (watched.isEmpty()) return
    val wait = min(30.0, 2.0.pow(retries)) * Random.nextDouble(0.5, 1.0)
    retries += 1
    Nap.main.launch {
      delay(wait.seconds)
      if (watched.isNotEmpty()) connect()
    }
  }
}

/** A page's collections: `site.db.collection("games", Game.serializer())`. */
class NapDB internal constructor(private val site: NapSite) {
  /**
   * One object per collection, type and page, so every screen sees the same documents.
   * `keepCopy` keeps them on the device too: the next launch shows them at once.
   */
  fun <T> collection(name: String, serializer: KSerializer<T>, keepCopy: Boolean = false): NapCollection<T> =
    site.collection(name, serializer, keepCopy)

  /** A collection of any JSON. */
  fun collection(name: String, keepCopy: Boolean = false): NapCollection<JsonElement> =
    site.collection(name, JsonElement.serializer(), keepCopy)
}

/** ICE servers for WebRTC, from `site.rtc()`. */
data class NapRtc(
  val iceServers: List<Server>,
  /** Whether there are TURN relays, for networks where a direct path fails. */
  val turn: Boolean,
  val expiresAt: Instant?,
) {
  data class Server(val urls: List<String>, val username: String? = null, val credential: String? = null)

  companion object {
    internal fun parse(json: JsonObject): NapRtc {
      fun JsonElement?.text() = (this as? JsonPrimitive)?.contentOrNull
      val servers = (json["iceServers"] as? JsonArray).orEmpty().mapNotNull { element ->
        val server = element as? JsonObject ?: return@mapNotNull null
        val urls = when (val urls = server["urls"]) {
          is JsonArray -> urls.mapNotNull { it.text() }
          else -> listOfNotNull(urls.text())
        }
        Server(urls, server["username"].text(), server["credential"].text())
      }
      return NapRtc(
        iceServers = servers,
        turn = (json["turn"] as? JsonPrimitive)?.booleanOrNull ?: false,
        expiresAt = json["expiresAt"].text()?.let { runCatching { Instant.parse(it) }.getOrNull() },
      )
    }
  }
}

/** What an extension's Kotlin client gets: requests to /_nap/ext/<name>/ of the page. */
class NapExtensionKit internal constructor(private val site: NapSite, val name: String) {
  private fun path(path: String) = site.url("ext/$name/${path.trimStart('/')}")

  suspend fun request(
    path: String,
    method: String = "GET",
    body: ByteArray? = null,
    contentType: String? = "application/json",
  ): NapResponse = Nap.send(method, path(path), body, contentType)

  suspend fun <T> json(
    path: String,
    deserializer: DeserializationStrategy<T>,
    method: String = "GET",
    body: JsonElement? = null,
  ): T = Nap.request(method, path(path), deserializer, body)
}
