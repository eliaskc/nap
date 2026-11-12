package nap.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * A file of a page (nap.files), from `site.files.upload`: its id, type, size in bytes, name, who
 * uploaded it (email), and when (ISO 8601).
 */
@Serializable
data class NapFile(
  val id: String,
  val type: String,
  val size: Long,
  val name: String? = null,
  val createdBy: String = "",
  val createdAt: String = "",
)

/**
 * The page's files, like nap.files on the web: photos and other blobs up to 15 MB, which everyone
 * who can see the page can read and delete. A file never changes; upload a new one instead. Keep
 * the id in a document to find the file again.
 */
class NapFiles internal constructor(private val site: NapSite) {
  /** Stores `bytes` as a new file of the page. `type` is its content type, such as "image/jpeg". */
  suspend fun upload(bytes: ByteArray, type: String, name: String? = null): NapFile {
    val headers = if (name.isNullOrEmpty()) emptyMap() else mapOf("x-nap-file-name" to Nap.encode(name))
    val response = Nap.send("POST", site.url("blobs"), bytes, type, headers)
    Nap.check(response)
    val file = try {
      (NapJson.parseToJsonElement(response.text()) as JsonObject)["file"]
    } catch (e: IllegalArgumentException) {
      null
    } ?: throw NapError("Nap answered something unexpected", status = response.status)
    return NapJson.decodeFromJsonElement(NapFile.serializer(), file)
  }

  /** The file's bytes, downloaded with the sign-in. Files never change, so keep them if you show them often. */
  suspend fun bytes(id: String): ByteArray {
    val response = Nap.send("GET", url(id))
    Nap.check(response)
    return response.body
  }

  /** Deletes the file. Documents that name it keep its id: remove that too. */
  suspend fun delete(id: String) {
    Nap.check(Nap.send("DELETE", url(id)))
  }

  /** /_nap/api/naps/<id>/blobs/<file>. It needs the Nap token: use [bytes] to show one. */
  fun url(id: String): String = site.url("blobs/${Nap.encode(id)}")
}
