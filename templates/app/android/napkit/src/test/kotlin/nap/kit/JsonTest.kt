package nap.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JsonTest {
  @Serializable
  data class Game(val name: String, val players: Int = 2)

  private fun json(text: String) = NapJson.parseToJsonElement(text) as JsonObject

  @Test
  fun changesFeedDecodesDocumentsAndDeletes() {
    val page = json(
      """
      {"changes": [
        {"id": "a", "version": 3, "data": {"name": "Weave", "extra": 1}, "createdBy": "e@x", "createdAt": "2026-01-01"},
        {"id": "b", "version": 4, "deleted": true},
        {"id": "c", "version": 5, "data": {"title": "not a game"}}
      ], "since": 42, "hasMore": true}
      """,
    )
    val (changes, since, more) = NapChange.page(page, Game.serializer())
    assertEquals(42, since)
    assertTrue(more)
    assertEquals(3, changes.size)
    assertEquals(Game("Weave"), changes[0].document?.data)
    assertEquals("e@x", changes[0].document?.createdBy)
    assertTrue(changes[1].deleted)
    assertNull(changes[1].document)
    // Data of another shape is skipped, not fatal.
    assertFalse(changes[2].deleted)
    assertNull(changes[2].document)
  }

  @Test
  fun anyJsonCollectionsKeepEverything() {
    val change = NapChange.parse(json("""{"id": "x", "version": 1, "data": [1, "two"]}"""), JsonElement.serializer())
    assertEquals("""[1,"two"]""", change?.document?.data.toString())
  }

  @Test
  fun errorsCarryTheCurrentDocument() {
    val error = napError(409, """{"error": "Conflict", "code": "conflict", "document": {"id": "a", "version": 7, "data": {"name": "New"}}}""")
    assertEquals("Conflict", error.message)
    assertEquals("conflict", error.code)
    assertEquals(7, error.document?.version)
    assertEquals(Game("New"), error.document?.decodeAs(Game.serializer())?.data)
    assertEquals("Nap answered 500", napError(500, "<html>").message)
    assertTrue(napError(401, """{"error": "invalid_token", "error_description": "Gone", "code": "invalid_token"}""").signedOut)
  }

  @Test
  fun iceServersTakeOneUrlOrMany() {
    val rtc = NapRtc.parse(
      json(
        """{"iceServers": [{"urls": "stun:a"}, {"urls": ["turn:b", "turns:c"], "username": "u", "credential": "p"}],
           "turn": true, "expiresAt": "2026-05-01T10:00:00.000Z"}""",
      ),
    )
    assertEquals(listOf("stun:a"), rtc.iceServers[0].urls)
    assertEquals(listOf("turn:b", "turns:c"), rtc.iceServers[1].urls)
    assertEquals("p", rtc.iceServers[1].credential)
    assertTrue(rtc.turn)
    assertNotNull(rtc.expiresAt)
  }

  @Test
  fun notificationsLeaveOutWhatIsMissing() {
    val body = NapJson.encodeToJsonElement(NapNotification.serializer(), NapNotification("Hi", app = "hello")) as JsonObject
    assertEquals(setOf("title", "app"), body.keys)
    assertEquals(JsonPrimitive("hello"), body["app"])
  }

  @Test
  fun peersDecodeWithPresence() {
    val peer = NapJson.decodeFromJsonElement(
      NapPeer.serializer(),
      json("""{"id": "p1", "email": "e@x", "name": "Elias K", "joinedAt": 12, "state": {"name": "Weave", "players": 3}}"""),
    )
    assertEquals("Elias", peer.firstName)
    assertEquals(Game("Weave", 3), peer.state(Game.serializer()))
    assertFalse(peer.isSelf)
  }
}
