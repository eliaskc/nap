# Nap app

iOS prototypes in SwiftUI, installed through Nap. One launcher app opens every prototype; a
prototype can also be its own app.

## Layout

- `Prototypes/<slug>/` is one prototype: `prototype.json` (title, summary, standalone), `Sources/`
  with a `public struct PrototypeView: View`, and optional `Resources/`. Slugs are lowercase
  letters, numbers, and hyphens. To start one, copy `Prototypes/hello`.
- `Apps/Launcher/` is the launcher.
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

## Limits

- No capabilities that need entitlements (push notifications, App Groups, iCloud, Sign in with
  Apple): the signing profile is a wildcard App ID. Networking, WebSockets, and audio are fine.
- No Swift packages from the internet unless you need them: builds should stay seconds long.
