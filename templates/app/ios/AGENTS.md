# {{title}} for iOS

The iOS platform of this repo: native apps in SwiftUI. One launcher holds every app and goes to
TestFlight; people install it from the TestFlight app. Paths here are inside `ios/`.

## Layout

- `Apps/<slug>/` is one app: `app.json` (title, summary, and what it needs: see below),
  `Sources/` with a `public struct AppView: View`, and optional `Resources/`. Slugs are lowercase
  letters, numbers, and hyphens. To start one, copy `Apps/hello`.
- `Launcher/` is the launcher. Its app icon is `Resources/Assets.xcassets/AppIcon.appiconset/icon.png`
  (1024 x 1024, no transparency); replace it, but keep one: TestFlight refuses builds without it.
  Its name on the home screen is `displayName` in `Project.swift`.
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
  Push notifications also need a server that sends them, which Nap does not have yet.

## Limits

- Networking, WebSockets, and audio need nothing declared. Audio that keeps running when the
  phone locks needs `"infoPlist": {"UIBackgroundModes": ["audio"]}`, and MultipeerConnectivity or
  Bonjour need `NSLocalNetworkUsageDescription` in `permissions` and `NSBonjourServices` in
  `infoPlist`. The whole launcher gets them, like capabilities.
- iPhone only, and `ITSAppUsesNonExemptEncryption` stays false (HTTPS is exempt): TestFlight
  needs both.
- No Swift packages from the internet unless you need them: builds should stay seconds long. An
  app that needs one lists it in `app.json`:
  `"packages": [{"url": "https://github.com/…", "version": "1.2.3", "products": ["Name"]}]`.
- Prebuilt `.xcframework`s go in the app's folder (such as `Frameworks/`), committed, and are
  listed in `app.json` as `"frameworks": ["Frameworks/Foo.xcframework"]`. The launcher embeds
  them. Build them for device and simulator.
