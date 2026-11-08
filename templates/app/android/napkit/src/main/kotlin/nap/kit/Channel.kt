package nap.kit

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Someone in a channel: a web page or an app. `state` is their presence. */
@Serializable
data class NapPeer(
  val id: String,
  val email: String = "",
  val name: String = "",
  val shape: String? = null,
  val color: String? = null,
  val joinedAt: Double = 0.0,
  val state: JsonElement? = null,
  /** This device's own connection. */
  @Transient val isSelf: Boolean = false,
) {
  val person: NapPerson get() = NapPerson(email, name, shape, color)
  val firstName: String get() = person.firstName

  /** Their presence as a type, if it decodes. */
  fun <S> state(serializer: KSerializer<S>): S? =
    state?.let { runCatching { NapJson.decodeFromJsonElement(serializer, it) }.getOrNull() }
}

/**
 * A channel of a page, like nap.channel(name) on the web: presence and messages between everyone
 * on it, web pages and apps alike. It reconnects by itself until `leave()`. `M` is the messages'
 * type (`site.channel(name, GameMessage.serializer())`), or JsonElement. Composables that read
 * `peers` or `isOpen` update with them; the callbacks are for game loops that want each event.
 * They run on the main thread.
 */
class NapChannel<M> internal constructor(
  private val site: NapSite,
  val name: String,
  private val messages: KSerializer<M>,
  /** Watching: this device sees the peers but is not one of them (see `NapSite.watch`). */
  val isWatching: Boolean = false,
) {
  /** Everyone on the channel, oldest first, this device included. */
  var peers: List<NapPeer> by mutableStateOf(emptyList())
    private set
  var isOpen: Boolean by mutableStateOf(false)
    private set
  /** This device's id on the channel, while it is open. */
  var selfId: String? by mutableStateOf(null)
    private set
  /**
   * Whether the site runs a server for this channel (`servers` in its nap.json). Send to it with
   * `send(data, to = "server")`; its messages come from the peer id "server".
   */
  var hasServer: Boolean by mutableStateOf(false)
    private set

  var onPresence: ((List<NapPeer>) -> Unit)? = null
  var onJoin: ((NapPeer) -> Unit)? = null
  var onLeave: ((NapPeer) -> Unit)? = null
  var onMessage: ((NapPeer, M) -> Unit)? = null
  var onStatus: ((Boolean) -> Unit)? = null
  var onError: ((String) -> Unit)? = null

  private var socket: WebSocket? = null
  private var map = mutableMapOf<String, NapPeer>()
  private var presence: JsonElement? = null
  private var retries = 0
  /** Bumped on every connect, so a retry that was waiting does not open a second socket. */
  private var attempt = 0
  private var left = false
  private var pingJob: Job? = null

  init {
    connect()
  }

  /** Other people's connections (not this device's). */
  val others: List<NapPeer> get() = peers.filter { !it.isSelf }

  /** Sets this device's presence, which everyone sees in `peers`. */
  fun setPresence(state: JsonElement) {
    if (isWatching) return
    presence = state
    selfId?.let { id -> map[id]?.let { map[id] = it.copy(state = state); publish() } }
    if (isOpen) raw(buildJsonObject { put("t", "presence"); put("state", state) })
  }

  /** Sets this device's presence as any serializable value. */
  inline fun <reified S> setPresence(state: S) = setPresence(NapJson.encodeToJsonElement(serializer<S>(), state))

  /**
   * Sends a message to everyone else, to one peer by id, or to the channel's server with
   * `to = "server"`. False while the channel is closed.
   */
  fun send(data: M, to: String? = null): Boolean {
    if (!isOpen || isWatching) return false
    return raw(buildJsonObject {
      put("t", "send")
      put("data", NapJson.encodeToJsonElement(messages, data))
      if (to != null) put("to", to)
    })
  }

  /** Drops the connection and connects again now, e.g. after the app was in the background. */
  fun refresh() {
    if (left) return
    socket?.let {
      it.close(1001, null)
      closed(it)
    }
    retries = 0
    connect()
  }

  fun leave() {
    left = true
    pingJob?.cancel()
    // A moment for the last messages, such as a goodbye, to go out before the socket closes.
    val ws = socket
    Nap.main.launch {
      delay(300.milliseconds)
      ws?.close(1000, null)
    }
    socket = null
    isOpen = false
  }

  // The socket (src/lib/site-channel.ts)

  private fun connect() {
    val token = Nap.account.token
    if (left || token == null) return
    attempt += 1
    val url = site.url("channel/${Nap.encode(name)}") + if (isWatching) "?watch=1" else ""
    val request = Request.Builder().url(url).header("authorization", "Bearer $token").build()
    lateinit var ws: WebSocket
    ws = Nap.sockets.newWebSocket(request, object : WebSocketListener() {
      override fun onMessage(webSocket: WebSocket, text: String) {
        if (text == "pong") return
        Nap.main.launch { if (socket === ws) handle(text) }
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
  }

  private fun handle(text: String) {
    val message = runCatching { NapJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
    fun field(name: String) = (message[name] as? JsonPrimitive)?.contentOrNull
    fun peer(json: JsonElement?) = json?.let { runCatching { NapJson.decodeFromJsonElement(NapPeer.serializer(), it) }.getOrNull() }
    when (field("t")) {
      "welcome" -> {
        selfId = field("id")
        hasServer = (message["server"] as? JsonPrimitive)?.booleanOrNull == true
        retries = 0
        map = mutableMapOf()
        (message["peers"] as? JsonArray).orEmpty().mapNotNull(::peer).forEach {
          map[it.id] = it.copy(isSelf = it.id == selfId)
        }
        startPing()
        val presence = presence
        val id = selfId
        if (presence != null && id != null) {
          map[id]?.let { map[id] = it.copy(state = presence) }
          raw(buildJsonObject { put("t", "presence"); put("state", presence) })
        }
        isOpen = true
        publish()
        onStatus?.invoke(true)
        onPresence?.invoke(peers)
      }
      "join" -> {
        val peer = peer(message["peer"])?.let { it.copy(isSelf = it.id == selfId) } ?: return
        map[peer.id] = peer
        publish()
        onJoin?.invoke(peer)
        onPresence?.invoke(peers)
      }
      "leave" -> {
        val peer = field("id")?.let { map.remove(it) } ?: return
        publish()
        onLeave?.invoke(peer)
        onPresence?.invoke(peers)
      }
      "presence" -> {
        val id = field("id") ?: return
        val peer = map[id] ?: return
        map[id] = peer.copy(state = message["state"])
        publish()
        onPresence?.invoke(peers)
      }
      "message" -> {
        val from = message["from"] as? JsonObject ?: return
        // A message of another shape (another version of the page) is dropped, not fatal.
        val data = message["data"]?.let { runCatching { NapJson.decodeFromJsonElement(messages, it) }.getOrNull() } ?: return
        val id = (from["id"] as? JsonPrimitive)?.contentOrNull ?: return
        val sender = map[id] ?: peer(from) ?: NapPeer(id)
        onMessage?.invoke(sender, data)
      }
      "error" -> field("error")?.let { onError?.invoke(it) }
    }
  }

  private fun publish() {
    peers = map.values.sortedWith(compareBy<NapPeer> { it.joinedAt }.thenBy { it.id })
  }

  private fun startPing() {
    pingJob?.cancel()
    pingJob = Nap.main.launch {
      while (isActive) {
        delay(30.seconds)
        socket?.send("ping")
      }
    }
  }

  private fun closed(ws: WebSocket) {
    if (socket !== ws) return
    pingJob?.cancel()
    socket = null
    selfId = null
    val hadPeers = map.isNotEmpty()
    map = mutableMapOf()
    publish()
    if (isOpen) {
      isOpen = false
      onStatus?.invoke(false)
    }
    if (hadPeers) onPresence?.invoke(emptyList())
    if (left) return
    val wait = min(15.0, 0.5 * 2.0.pow(retries)) * Random.nextDouble(0.5, 1.0)
    retries += 1
    val next = attempt
    Nap.main.launch {
      delay(wait.seconds)
      if (attempt == next && socket == null) connect()
    }
  }

  private fun raw(message: JsonObject): Boolean = socket?.send(message.toString()) ?: false
}
