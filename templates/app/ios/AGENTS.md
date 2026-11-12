# {{title}} for iOS

The iOS platform of this repo: native apps in SwiftUI. One launcher holds every app and goes to
TestFlight; people install it from the TestFlight app. Paths here are inside `ios/`.

## Layout

- `Apps/<slug>/` is one app: `app.json` (title, summary, and what it needs: see below),
  `Sources/` with a `public struct AppView: View`, and optional `Resources/`. Slugs are lowercase
  letters, numbers, and hyphens. To start one, copy `Apps/hello`.
- `Launcher/` is the launcher. Its app icon is `Resources/AppIcon.icon`, an Icon Composer icon
  (the instance's icon when the repo was made). Edit it in Icon Composer, or swap it for an
  `AppIcon.appiconset` with a 1024 x 1024 PNG, but keep one: TestFlight refuses builds without it.
  Its name on the home screen is `displayName` in `Project.swift`.
- `NapKit/` is Nap's client for Swift (see below). Every app links it. Never edit it:
  `scripts/napkit` replaces it with the one Nap serves; commit what it changes.
- `Project.swift` finds apps by folder. Never edit or commit an `.xcodeproj`: it is generated.
- `../nap.json` names the app on Nap.

## Build and publish

Needs a Mac with Xcode and Tuist (`mise install` reads `mise.toml`).

```sh
cd ios
scripts/generate                      # registry + Xcode project, after every pull
scripts/build                         # unsigned device build: build/launcher.zip
git commit -am "feat: …"
scripts/publish "What changed, for testers"
```

`scripts/publish` pushes HEAD to main of the repo on Nap, uploads the build with that commit, and
Nap signs it and sends it to TestFlight. Apple processes it for a few minutes. Nap only takes a
build of the head of main that contains the live build's commit. If someone pushed first, pull,
merge, and publish again.

Test in the Simulator while you work: open the generated project in Xcode, or
`xcodebuild -scheme Launcher -sdk iphonesimulator`. Simulator builds cannot be published.

## Permissions and capabilities

Declare them in the app's `app.json`; never edit `Project.swift` or Info.plist for them.
`scripts/generate` puts them into the launcher.

```json
{
  "title": "Snore demo",
  "permissions": { "NSMicrophoneUsageDescription": "Records snoring for the demo." },
  "capabilities": ["healthkit"]
}
```

- `permissions`: Info.plist usage strings (`NSCameraUsageDescription`,
  `NSMicrophoneUsageDescription`, `NSLocationWhenInUseUsageDescription`,
  `NSPhotoLibraryUsageDescription`, `NSMotionUsageDescription`, …). Apple refuses a build that
  uses one of these APIs without its string. Say why the app asks, in a sentence.
- `infoPlist`: any other Info.plist keys the app needs, such as background modes or the Bonjour
  services of a local-network feature:
  `{"UIBackgroundModes": ["audio"], "NSBonjourServices": ["_my-app._tcp"]}`. Lists from several
  apps are combined; for other values the first app (by slug) wins. Keys `Project.swift` sets
  itself (bundle names, versions, orientations, encryption) stay as they are. Entitlements never
  go here: they are capabilities.
- `capabilities`: Nap turns these on for the App ID when it signs: `push-notifications`,
  `healthkit`, `siri`, `nfc-tag-reading`, `wifi-info`, `homekit`, `game-center`. A Nap can limit
  which. It cannot turn on `app-groups`, `icloud`, `associated-domains`, `sign-in-with-apple`, or
  `apple-pay` (they need setup in the developer account).
- What the build does not get, Nap says when you publish, and the launcher shows it on the app in
  orange. Code that needs a missing capability should fail gracefully.
- Capabilities are shared: every app in the launcher has what any one of them asked for.
- Nap's own notifications need nothing declared: on a Nap with notifications and an APNs key,
  every launcher gets push notifications, and NapKit registers for them.

## NapKit: Nap data, channels, and notifications

`import NapKit` gives Swift what a web page gets as `window.nap`. Apps cannot pass Cloudflare
Access, so the launcher signs in to Nap once (the device flow) and NapKit sends that token. A
page's data and channels are the same for the app and the page's web version, so they play
together.

```swift
import NapKit
import SwiftUI

struct Game: Codable, Sendable { var name: String }

public struct AppView: View {
  let games = Nap.site("weave").db.collection("games", of: Game.self)   // the page "weave"
  var account = Nap.account

  public init() {}

  public var body: some View {
    if !account.signedIn {
      NapSignInButton()                                    // the launcher's one sign-in
    } else {
      List(games.documents) { doc in                       // live: updates as anyone writes
        Text(doc.data.name)
      }
      .onAppear { games.watch() }
    }
  }
}
```

- `Nap.site(id)`: a page by its id. `db.collection(name, of: T.self)` (or `db.collection(name)`
  for any JSON, `JSONValue`): `documents` (newest first, `doc.data` is a `T`), `loaded`,
  `error`, `watch()` and `unwatch()`, `onChange { }`, `document(id)`, `get`, `create`,
  `put(id, data, ifVersion:, ifNew:)`, `patch`, `delete`, `ensure` (create once), and
  `mutate(id) { old in new }`, which retries when someone else saved first. Documents that do not
  decode as `T` are skipped. `keepCopy: true` keeps them on the phone, so the app opens on what
  it saw last; signing out deletes them. `site.live` says whether changes arrive at once.
- `site.channel(name, messages: M.self)` (or `site.channel(name)` for any JSON): presence
  (`setPresence`, `peers`) and messages (`send(_:to:)`, `onMessage`), with everyone on the
  page's channel, web or app. Messages that do not decode as `M` are dropped. `leave()` when done.
- `site.watch(name)`: the channel's `peers` and their presence, live, without joining it: nobody
  sees this device and it cannot send. For showing who is in a lobby, as the launcher does.
- `site.rtc()`: ICE servers for WebRTC between people on the page (STUN, and TURN relays when
  the Nap has them).
- `site.fetch(url)`: APIs the page lists in its nap.json, like nap.fetch.
- `site.files`: the page's files, like nap.files (photos and other blobs up to 15 MB, shared
  with everyone who can see the page). `upload(data, type: "image/jpeg", name: "photo.jpg")`
  returns a `NapFile` (`id`, `type`, `size`, `name`, `createdBy`, `createdAt`); keep its `id` in
  a document. `data(id)` downloads one with the sign-in, `delete(id)` removes it. Files never
  change, so cache what you show. Scale photos down before uploading.
- `site.notify(title:body:open:skip:only:tag:quiet:image:)`: a notification to everyone else who can see the page (but `skip`, a list of emails; or `only` those), on their
  phones and in their browsers, never to the sender. A newer one with the same `tag` replaces the older one; `quiet` has no sound or banner. `image`: the id of an
  image file of the page (`files.upload`): the launcher's notification extension
  (`Launcher/Notifications`) shows it as the thumbnail and when expanded. Only on Naps with notifications; a few a
  minute. Put `"site": "<id>"` in the app's app.json so a tap on that page's notifications opens
  the app. An app with no page uses `Nap.notify(title:body:open:app: "<its folder>")`.
- `Nap.me()`, `Nap.people()`: names and looks. `Nap.account`: `signedIn`, `email`, `name`.
- Extensions of this Nap are properties on the site, such as `site.<name>`, when the Nap has a
  Swift client for them (in `NapKit/Sources/Extensions/`).
- Errors are `NapError` (`message`, `status`, `code`). A lost sign-in signs out by itself.
- Test against a local Nap with the launch argument `-nap-url http://localhost:1337` and a token
  with `-nap-token <token>`.

## Limits

- Networking, WebSockets, and audio need nothing declared. Audio that keeps running when the
  phone locks needs `"infoPlist": {"UIBackgroundModes": ["audio"]}`, and MultipeerConnectivity or
  Bonjour need `NSLocalNetworkUsageDescription` in `permissions` and `NSBonjourServices` in
  `infoPlist`. The whole launcher gets them, like capabilities.
- iPhone and iPad, in every orientation on iPad (Icon Composer's `AppIcon.icon` makes the iPad
  icons), and `ITSAppUsesNonExemptEncryption` stays false (HTTPS is exempt): TestFlight needs
  both. Apps should lay out for an iPad's width: use size classes, not fixed phone widths.
- No Swift packages from the internet unless you need them: builds should stay seconds long. An
  app that needs one lists it in `app.json`:
  `"packages": [{"url": "https://github.com/…", "version": "1.2.3", "products": ["Name"]}]`.
- Prebuilt `.xcframework`s go in the app's folder (such as `Frameworks/`), committed, and are
  listed in `app.json` as `"frameworks": ["Frameworks/Foo.xcframework"]`. The launcher embeds
  them. Build them for device and simulator.
