package nap.kit

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushTest {
  private fun open(vararg extras: Pair<String, String>) = NapOpen.from(mapOf(*extras)::get)

  @Test
  fun tapsOnSitesNameTheSite() {
    val opened = open("url" to "https://nap.example/weave/", "source" to "site:weave", "google.message_id" to "1")
    assertEquals(NapOpen("https://nap.example/weave/", "site:weave"), opened)
    assertEquals("weave", opened?.site)
    assertNull(opened?.app)
  }

  @Test
  fun tapsOnAppsNameTheFolder() {
    val opened = open("url" to "https://nap.example/", "source" to "app:hello")
    assertEquals("hello", opened?.app)
    assertNull(opened?.site)
  }

  @Test
  fun otherSourcesOnlyHaveTheUrl() {
    for (source in listOf("app", "test", "", "site:", "app:")) {
      val opened = open("url" to "https://nap.example/", "source" to source)
      assertNull(opened?.site)
      assertNull(opened?.app)
      assertEquals("https://nap.example/", opened?.url)
    }
  }

  @Test
  fun otherIntentsAreNotTaps() {
    assertNull(open())
    assertNull(open("open" to "hello", "site" to "weave"))
    // Only web URLs open in the browser.
    assertEquals(NapOpen(null, "app:hello"), open("url" to "intent://evil", "source" to "app:hello"))
  }

  @Test
  fun firebaseSettingsOnlyWhenEnabled() {
    fun parse(text: String) = FirebaseConfig.parse(NapJson.parseToJsonElement(text) as JsonObject)
    assertNull(parse("""{"enabled": false}"""))
    assertNull(parse("""{"enabled": true}"""))
    assertNull(parse("""{"enabled": true, "firebase": {"apiKey": "k"}}"""))
    assertEquals(
      FirebaseConfig("k", "1:123:android:abc", "nap-push", "123"),
      parse("""{"enabled": true, "firebase": {"apiKey": "k", "appId": "1:123:android:abc", "projectId": "nap-push", "senderId": "123", "more": 1}}"""),
    )
  }
}
