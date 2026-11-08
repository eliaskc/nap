package nap.kit

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.io.File
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** A document as Nap stores it, with its data as the collection's type. */
@Serializable
data class NapDocument<T>(
  val id: String,
  val data: T,
  val version: Int = 0,
  val createdBy: String = "",
  val updatedBy: String = "",
  val createdAt: String = "",
  val updatedAt: String = "",
) {
  internal fun <U> copyWith(data: U) = NapDocument(id, data, version, createdBy, updatedBy, createdAt, updatedAt)
}

/** The same document with its data as another type, if it decodes: `error.document?.decodeAs(Game.serializer())`. */
fun <U> NapDocument<JsonElement>.decodeAs(serializer: KSerializer<U>): NapDocument<U>? =
  runCatching { copyWith(NapJson.decodeFromJsonElement(serializer, data)) }.getOrNull()

/**
 * A write from the changes feed or the live socket: a document, or a delete. A document whose
 * data does not decode as the collection's type has no `document`, and is skipped.
 */
internal class NapChange<T>(val id: String, val version: Int, val deleted: Boolean, val document: NapDocument<T>?) {
  companion object {
    fun <T> parse(json: JsonElement?, serializer: KSerializer<T>): NapChange<T>? {
      val change = json as? JsonObject ?: return null
      val id = (change["id"] as? JsonPrimitive)?.contentOrNull ?: return null
      val version = (change["version"] as? JsonPrimitive)?.intOrNull ?: 0
      val deleted = (change["deleted"] as? JsonPrimitive)?.booleanOrNull ?: false
      val document = if (deleted) null else runCatching {
        NapJson.decodeFromJsonElement(NapDocument.serializer(serializer), change)
      }.getOrNull()
      return NapChange(id, version, deleted, document)
    }

    /** A page of the changes feed: its changes, where the next page starts, and whether there is one. */
    fun <T> page(json: JsonObject, serializer: KSerializer<T>): Triple<List<NapChange<T>>, Int, Boolean> {
      val changes = (json["changes"] as? JsonArray).orEmpty().mapNotNull { parse(it, serializer) }
      val since = (json["since"] as? JsonPrimitive)?.intOrNull ?: 0
      val more = (json["hasMore"] as? JsonPrimitive)?.booleanOrNull ?: false
      return Triple(changes, since, more)
    }
  }
}

/** What every collection of a site does for it, whatever its type. */
internal interface NapCollectionBase {
  val name: String
  val watched: Boolean
  suspend fun poll()
  fun receive(message: JsonObject)
  fun forget()
}

/**
 * One collection of a page, like nap.db.collection<T>(name) on the web:
 * `Nap.site("elo").db.collection("games", Game.serializer())`. `watch()` keeps `documents`
 * current with the live socket (polling as a safety net); composables that read it update with
 * it, and `onChange` calls back after each batch of changes. Writes apply at once.
 */
class NapCollection<T> internal constructor(
  val site: NapSite,
  override val name: String,
  private val serializer: KSerializer<T>,
) : NapCollectionBase {
  /** Every document, newest first. Empty until the first load: see `loaded`. */
  var documents: List<NapDocument<T>> by mutableStateOf(emptyList())
    private set
  /** Whether the documents are known: loaded from Nap, or from the copy on the device. */
  var loaded: Boolean by mutableStateOf(false)
    private set
  /** Why the last load failed, while it has not succeeded since. */
  var error: NapError? by mutableStateOf(null)
    private set

  private val documentSerializer = NapDocument.serializer(serializer)
  private var byId = mutableMapOf<String, NapDocument<T>>()
  /** The version of each deleted document, so an older change cannot bring it back. */
  private var deletedAt = mutableMapOf<String, Int>()
  private var since = 0
  override var watched = false
    private set
  private val listeners = mutableListOf<() -> Unit>()
  private var keepsCopy = false
  private var saveJob: Job? = null

  fun document(id: String): NapDocument<T>? = byId[id]

  /** Calls back after each batch of changes, for state derived from the documents. */
  fun onChange(listener: () -> Unit) {
    listeners += listener
  }

  /** Loads the collection and keeps it current. Needs someone signed in. */
  fun watch() {
    if (!Nap.account.signedIn) return
    if (!watched) {
      watched = true
      Nap.main.launch { poll() }
    }
    site.watching()
  }

  /** Stops keeping it current, e.g. when the app closes. The documents stay. */
  fun unwatch() {
    watched = false
    site.unwatched()
  }

  // Changes

  /** Takes changes from the socket, a poll, or a write, unless newer ones are here already. */
  private fun apply(changes: List<NapChange<T>>): Boolean {
    var changed = false
    for (change in changes) {
      val known = byId[change.id]?.version ?: deletedAt[change.id] ?: 0
      if (change.version <= known) continue
      if (change.deleted) {
        deletedAt[change.id] = change.version
        if (byId.remove(change.id) != null) changed = true
      } else if (change.document != null) {
        byId[change.id] = change.document
        deletedAt.remove(change.id)
        changed = true
      }
    }
    return changed
  }

  private fun applied(document: NapDocument<T>) {
    val known = byId[document.id]?.version ?: deletedAt[document.id] ?: 0
    if (document.version <= known) return
    byId[document.id] = document
    deletedAt.remove(document.id)
    publish()
  }

  private fun removed(id: String) {
    val document = byId.remove(id) ?: return
    deletedAt[id] = document.version + 1
    publish()
  }

  private fun publish() {
    documents = byId.values.sortedWith(compareByDescending<NapDocument<T>> { it.createdAt }.thenByDescending { it.id })
    if (!loaded) loaded = true
    listeners.forEach { it() }
    saveSoon()
  }

  /** Catches up with the changes feed, applying it in one go. */
  override suspend fun poll() {
    try {
      val changes = mutableListOf<NapChange<T>>()
      var next = since
      var more = true
      while (more) {
        val page = Nap.request("GET", site.url("data/${Nap.encode(name)}?since=$next&limit=500"), JsonObject.serializer())
        val (some, nextSince, hasMore) = NapChange.page(page, serializer)
        changes += some
        next = nextSince
        more = hasMore
      }
      since = maxOf(since, next)
      error = null
      if (apply(changes) || !loaded) publish()
    } catch (failure: NapError) {
      error = failure
    }
  }

  /** A change from the site's live socket: {"type": "change", "collection": …, "change": {…}}. */
  override fun receive(message: JsonObject) {
    val change = NapChange.parse(message["change"], serializer) ?: return
    if (apply(listOf(change))) publish()
  }

  /** Signed out: nothing of the person's stays, in memory or on the device. */
  override fun forget() {
    watched = false
    byId = mutableMapOf()
    deletedAt = mutableMapOf()
    since = 0
    documents = emptyList()
    loaded = false
    error = null
    saveJob?.cancel()
  }

  // The copy on the device

  @Serializable
  private class Copy<T>(val since: Int, val documents: List<NapDocument<T>>, val deleted: Map<String, Int>)

  private val copySerializer get() = Copy.serializer(serializer)
  private val copyFile: File get() = File(Nap.copies(), "${site.id}-$name.json")

  /**
   * Keeps a copy on the device, so the next launch shows the documents at once and only fetches
   * what changed since. Signing out deletes it.
   */
  internal fun keepCopy() {
    if (keepsCopy) return
    keepsCopy = true
    if (loaded || !Nap.account.signedIn) return
    val copy = runCatching { NapJson.decodeFromString(copySerializer, copyFile.readText()) }.getOrNull() ?: return
    since = copy.since
    deletedAt = copy.deleted.toMutableMap()
    byId = copy.documents.associateBy { it.id }.toMutableMap()
    publish()
  }

  private fun saveSoon() {
    if (!keepsCopy || !Nap.account.signedIn) return
    saveJob?.cancel()
    val copy = Copy(since, byId.values.toList(), deletedAt.toMap())
    val file = copyFile
    saveJob = Nap.main.launch(Dispatchers.IO) {
      delay(1.seconds)
      val text = NapJson.encodeToString(copySerializer, copy)
      file.parentFile?.mkdirs()
      val temporary = File(file.parentFile, file.name + ".tmp")
      temporary.writeText(text)
      temporary.renameTo(file)
    }
  }

  // Reads and writes

  private fun item(id: String) = site.url("data/${Nap.encode(name)}/${Nap.encode(id)}")

  private fun saved(json: JsonObject): NapDocument<T> =
    NapJson.decodeFromJsonElement(documentSerializer, json["document"] ?: throw NapError("Nap answered no document", status = 0))

  private fun preconditions(ifVersion: Int?, ifNew: Boolean) = buildMap {
    if (ifVersion != null) put("if-match", "\"$ifVersion\"")
    if (ifNew) put("if-none-match", "*")
  }

  suspend fun get(id: String): NapDocument<T> =
    saved(Nap.request("GET", item(id), JsonObject.serializer())).also { applied(it) }

  /** A new document with an id Nap picks. */
  suspend fun create(data: T): NapDocument<T> = saved(
    Nap.request("POST", site.url("data/${Nap.encode(name)}"), JsonObject.serializer(), NapJson.encodeToJsonElement(serializer, data)),
  ).also { applied(it) }

  /**
   * Creates or replaces the document with this id. `ifNew` only creates (412 if it exists);
   * `ifVersion` fails with a 409 NapError if someone saved in between.
   */
  suspend fun put(id: String, data: T, ifVersion: Int? = null, ifNew: Boolean = false): NapDocument<T> = saved(
    Nap.request(
      "PUT", item(id), JsonObject.serializer(), NapJson.encodeToJsonElement(serializer, data),
      preconditions(ifVersion, ifNew),
    ),
  ).also { applied(it) }

  /** Merges fields into a document (JSON Merge Patch: `JsonNull` removes a field). */
  suspend fun patch(id: String, fields: JsonObject, ifVersion: Int? = null): NapDocument<T> = saved(
    Nap.request("PATCH", item(id), JsonObject.serializer(), fields, preconditions(ifVersion, false)),
  ).also { applied(it) }

  suspend fun delete(id: String, ifVersion: Int? = null) {
    Nap.check(Nap.send("DELETE", item(id), headers = preconditions(ifVersion, false)))
    removed(id)
  }

  /** Creates a document once; someone else creating it first is fine. */
  suspend fun ensure(id: String, data: T) {
    try {
      put(id, data, ifNew = true)
    } catch (_: NapError) {
    }
  }

  /**
   * Applies `change` to the newest version of a document and saves it, again when someone else
   * saved first. Return null to leave it. Like `mutate` in web pages.
   */
  suspend fun mutate(id: String, change: (T?) -> T?) {
    var current = document(id)
    repeat(6) {
      val next = change(current?.data) ?: return
      try {
        val base = current
        if (base != null) put(id, next, ifVersion = base.version) else put(id, next, ifNew = true)
        return
      } catch (error: NapError) {
        if (error.status != 409 && error.status != 412) throw error
        val latest = error.document?.decodeAs(serializer)
        if (latest != null) {
          applied(latest)
          current = latest
        } else {
          current = try { get(id) } catch (_: NapError) { null }
        }
      }
    }
    throw NapError("Too many people changed this at once. Try again.", status = 409)
  }
}
