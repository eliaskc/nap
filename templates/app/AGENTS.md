# Nap app

iOS prototypes in SwiftUI, installed through Nap. One launcher app opens every prototype; a
prototype can also be its own app.

## Layout

- `Prototypes/<slug>/` is one prototype: `prototype.json` (title, summary, standalone, and what it
  needs: see below), `Sources/`
  with a `public struct PrototypeView: View`, and optional `Resources/`. Slugs are lowercase
  letters, numbers, and hyphens. To start one, copy `Prototypes/hello`.
- `Apps/Launcher/` is the launcher. Its app icon is `Resources/Assets.xcassets/AppIcon.appiconset/icon.png`
  (1024 x 1024, no transparency); replace it, but keep one: TestFlight refuses builds without it.
- `Project.swift` finds prototypes by folder. Never edit or commit an `.xcodeproj`: it is generated.
- `nap.json` names the app on Nap.

## Build and publish

Needs a Mac with Xcode and Tuist (`mise install` reads `mise.toml`).

```sh
scripts/generate                      # registry + Xcode project, after every pull
scripts/build launcher                # unsigned device build: build/launcher.zip
git commit -am "feat: …"
scripts/publish launcher "What changed, for testers"
scripts/publish <slug>                # a standalone prototype
```

`scripts/publish` pushes HEAD to main of the app's repo on Nap, uploads the build with that
commit, and Nap signs it. Nap only takes a build of the head of main that contains the live
build's commit. If someone pushed first, pull, merge, and publish again.

Test in the Simulator while you work: open the generated project in Xcode, or
`xcodebuild -scheme Launcher -sdk iphonesimulator`. Simulator builds cannot be published.

## Permissions and capabilities

Declare them in the prototype's `prototype.json`; never edit `Project.swift` or Info.plist for
them. `scripts/generate` puts them into the app.

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
  uses one of these APIs without its string. Say why the prototype asks, in a sentence.
- `capabilities`: Nap turns these on for the TestFlight app when it signs: `push-notifications`,
  `healthkit`, `siri`, `nfc-tag-reading`, `wifi-info`, `homekit`, `game-center`. A Nap can limit
  which. It cannot turn on `app-groups`, `icloud`, `associated-domains`, `sign-in-with-apple`, or
  `apple-pay` (they need setup in the developer account), nor any in ad hoc builds.
- What the build does not get, Nap says when you publish, and the launcher shows it on the
  prototype in orange. Code that needs a missing capability should fail gracefully.
- Capabilities are shared: every prototype in the launcher has what any one of them asked for.
  Push notifications also need a server that sends them, which Nap does not have.

## Limits

- Networking, WebSockets, and audio need nothing declared.
- iPhone only, and `ITSAppUsesNonExemptEncryption` stays false (HTTPS is exempt): TestFlight
  needs both.
- No Swift packages from the internet unless you need them: builds should stay seconds long.
