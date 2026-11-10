# {{title}} for Android

The Android platform of this repo: native apps in Kotlin and Jetpack Compose. One launcher holds
every app and goes to Google Play's internal testing track; people install it from Play. Paths
here are inside `android/`.

## Layout

- `apps/<slug>/` is one app: `app.json` (title, summary, and what it needs: see below) and
  `src/main/kotlin/nap/apps/<slug>/` with a `@Composable fun AppView()` in the package
  `nap.apps.<slug>` (hyphens in the slug become underscores: `my-app` is `nap.apps.my_app`).
  Optional: `src/main/res/` and `src/main/AndroidManifest.xml`. Slugs are lowercase letters,
  numbers, and hyphens. To start one, copy `apps/hello` and rename its package.
- Every folder in `apps/` with an `app.json` is a module (`:apps:<slug>`), found by
  `settings.gradle.kts`. Their build is shared, in `build.gradle.kts`: an app has no build file.
- `launcher/` is the launcher. It lists the apps (a registry generated from their `app.json` at
  build time) and opens one full screen. Its icon is `src/main/res/mipmap-*/ic_launcher.png` (the
  instance's icon when the repo was made); its name on the home screen is `displayName` in
  `launcher/build.gradle.kts`.
- `napkit/` is Nap's client for Kotlin (see below). Every app gets it. Never edit it:
  `scripts/napkit` replaces it with the one Nap serves; commit what it changes.
- `gradle/libs.versions.toml` has the versions of the Android SDK, Kotlin, Compose, and NapKit's
  libraries. `../nap.json` names the app on Nap.

## Build and publish

Needs the Android SDK (Android Studio, or the command-line tools with `ANDROID_HOME` set; the
usual places are found by themselves) and a JDK (`mise install` reads `mise.toml`).

```sh
cd android
./gradlew :launcher:installDebug      # build and install on the emulator or a phone
scripts/build                         # unsigned release bundle: build/launcher.aab
git commit -am "feat: …"
scripts/publish "What changed, for testers"
```

`scripts/publish` pushes HEAD to main of the repo on Nap and uploads the bundle with that commit.
Nap signs it with the Play upload key, sets its version code, and sends it to Google Play's
internal testing track; Play makes it available within minutes. Testers join once from the opt-in
link under Get the app on the Nap dashboard, then install and update from Play. Nap only takes a
build of the head of main that contains the live build's commit. If someone pushed first, pull,
merge, and publish again.

Test on the emulator while you work: `emulator -list-avds`, start one, then
`./gradlew :launcher:installDebug` and open the launcher. Debug builds cannot be published.

```sh
adb shell am start -n <package>/nap.launcher.MainActivity -e open <slug>   # open an app at launch
adb exec-out screencap -p > shot.png                                        # see the screen
```

`<package>` is `applicationId` in `launcher/build.gradle.kts`.

## Permissions and libraries

An app declares Android permissions in its own `src/main/AndroidManifest.xml`; the build merges
them into the launcher's. Never edit the launcher's manifest for them.

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.RECORD_AUDIO" />
</manifest>
```

Dangerous permissions (microphone, camera, location, …) are also asked for at runtime, with
`rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission())`. Code should
work, or say why not, when someone says no. Permissions are shared: the launcher has what any
app asked for. Networking needs nothing declared (NapKit declares `INTERNET`).

Nap's own notifications need nothing declared either: on a Nap that sends notifications to
Android, the launcher asks to allow them once someone is signed in, and NapKit registers for them
(Firebase Cloud Messaging, with the Nap's Firebase project: there is no `google-services.json`).

An app that needs a library from Maven Central or Google's Maven lists it in `app.json`:

```json
{
  "title": "Snore demo",
  "summary": "Records snoring for the demo.",
  "site": "snore",
  "dependencies": ["io.coil-kt.coil3:coil-compose:3.3.0"]
}
```

Compose (Material 3 and its core icons), kotlinx.serialization, coroutines, and NapKit are there
already. Add libraries only when you need them: builds should stay quick.

## NapKit: Nap data, channels, and notifications

`import nap.kit.*` gives Kotlin what a web page gets as `window.nap`. Apps cannot pass Cloudflare
Access, so the launcher signs in to Nap once (the device flow) and NapKit sends that token. A
page's data and channels are the same for the app and the page's web version, so they play
together.

```kotlin
package nap.apps.games

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import kotlinx.serialization.Serializable
import nap.kit.Nap
import nap.kit.NapSignInButton

@Serializable
data class Game(val name: String)

private val games = Nap.site("weave").db.collection("games", Game.serializer())   // the page "weave"

@Composable
fun AppView() {
  if (!Nap.account.signedIn) {
    NapSignInButton()                                  // the launcher's one sign-in
    return
  }
  DisposableEffect(Unit) {
    games.watch()                                      // live: updates as anyone writes
    onDispose { games.unwatch() }
  }
  LazyColumn {
    items(games.documents, key = { it.id }) { doc -> Text(doc.data.name) }
  }
}
```

Writes are suspending calls: `val scope = rememberCoroutineScope()`, then
`scope.launch { games.create(Game("New")) }`. They are main-safe and fail with a `NapError`.

- `Nap.site(id)`: a page by its id. `db.collection(name, T.serializer())` (or
  `db.collection(name)` for any JSON, `JsonElement`): `documents` (newest first, `doc.data` is a
  `T`), `loaded`, `error`, `watch()` and `unwatch()`, `onChange { }`, `document(id)`, `get`,
  `create`, `put(id, data, ifVersion =, ifNew =)`, `patch(id, buildJsonObject { … })`, `delete`,
  `ensure` (create once), and `mutate(id) { old -> new }`, which retries when someone else saved
  first. Documents that do not decode as `T` are skipped. `keepCopy = true` keeps them on the
  phone, so the app opens on what it saw last; signing out deletes them. `site.live` says whether
  changes arrive at once. These are Compose state: composables that read them update.
- `site.channel(name, M.serializer())` (or `site.channel(name)` for any JSON): presence
  (`setPresence`, `peers`, `others`) and messages (`send(data, to =)`, `onMessage`), with
  everyone on the page's channel, web or app. Messages that do not decode as `M` are dropped.
  `leave()` when done (in `onDispose`).
- `site.watch(name)`: the channel's `peers` and their presence, live, without joining it: nobody
  sees this device and it cannot send. For showing who is in a lobby.
- `site.rtc()`: ICE servers for WebRTC between people on the page (STUN, and TURN relays when the
  Nap has them).
- `site.fetch(url)`: APIs the page lists in its nap.json, like nap.fetch.
- `site.notify(title, body, open, skip, only, tag, quiet)`: a notification to everyone else who can see the page (but `skip`, a list of emails; or `only` those), on
  their phones and in their browsers, never to the sender. A newer one with the same `tag` replaces the older one; `quiet` has no sound. Only on Naps with notifications; a
  few a minute. Put `"site": "<id>"` in the app's app.json so a tap on that page's notifications
  opens the app (otherwise the page opens in the browser). An app with no page uses
  `Nap.notify(title, body, open, app = "<its folder>")`, and a tap opens that app.
- `Nap.me()`, `Nap.people()`: names and looks. `Nap.account`: `signedIn`, `email`, `name`.
- Errors are `NapError` (`message`, `status`, `code`; status 0 when Nap could not be reached). A
  lost sign-in signs out by itself.
- Test against a local Nap: start a debug build (only debug builds allow plain HTTP) with `-e nap-url http://10.0.2.2:1337` (the host's
  localhost, as the emulator sees it) and a token with `-e nap-token <token>`. The URL is kept
  until `-e nap-url ''`.

## Limits

- The package name (`applicationId`) is the one this Nap publishes to Play: never change it.
  Keep `targetSdk` at what Play requires (in `gradle/libs.versions.toml`).
- The release bundle stays unsigned, with no `signingConfig`: Nap signs it. Never sign it here
  or in CI, and never commit a keystore.
- Phones only are tested; the launcher runs on Android 9 (API 28) and later.
