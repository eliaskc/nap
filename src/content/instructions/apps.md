# Native apps on Nap

Nap also hosts native apps, for things a web page cannot do, such as an onboarding flow that must feel native or a game that should feel at home on the phone. Nap publishes them; you never sign anything.

This Nap has one app on Nap, `{{napApp}}`: one Git repo with a folder per platform. On each platform, a launcher holds every app made for it, and Nap publishes each platform on its own. An app is a folder named after its slug on each platform it is on. Platforms here:

- `ios/`: SwiftUI, in a launcher that people install from TestFlight. Needs a Mac with Xcode, git, Node 20+, and Tuist (mise install, from ios/mise.toml).

Working on the repo:

- Get the source: node nap-publish.mjs app clone {{napApp}} [dir]. Pull before you start (node nap-publish.mjs app run {{napApp}} -- git -C <dir> pull nap main). If it does not exist yet, create it from the template once: node nap-publish.mjs app init {{napApp}} [dir] --title 'Name'.
- Read the repo's AGENTS.md, and the platform's (ios/AGENTS.md), before you change it.
- A new app is a new folder: on iOS, copy ios/Apps/hello. Never make a second app on Nap.
- A publish answers 409 "source_not_head" when someone pushed after you: pull, build, and publish again. "source_not_descendant" means your history drops a published commit: merge it back in. Never force-push main.

iOS:

- The project is ios/: the launcher in ios/Launcher/, and one folder per app in ios/Apps/<slug>/ (app.json, and Sources/ with a public struct AppView: View). Run ios/scripts/generate after every pull.
- Test in the Simulator while you work (xcodebuild -scheme Launcher -sdk iphonesimulator in ios/, or Xcode). Simulator builds cannot be published.
- Publish: commit, then ios/scripts/publish 'What changed, for testers'. It builds the launcher for iPhone without signing, pushes HEAD to main, and uploads the build with that commit. Nap signs it, gives it the next build number, and uploads it to App Store Connect; Apple processes it for a few minutes, and testers install or update it in the TestFlight app. People get it from Get the app on the dashboard; send anyone who cannot to {{admin}}.
- Keep the launcher's app icon (ios/Launcher/Resources) and ITSAppUsesNonExemptEncryption in ios/Project.swift: TestFlight refuses builds without them.
- Permissions, capabilities, and other Info.plist keys go in the app's app.json, never in Project.swift: "permissions" are Info.plist usage strings ({"NSCameraUsageDescription": "Why, in a sentence"}), "infoPlist" holds any other keys ({"UIBackgroundModes": ["audio"], "NSBonjourServices": ["_my-app._tcp"]}), and "capabilities" are names such as ["push-notifications", "healthkit"]. ios/AGENTS.md lists them. Nap turns capabilities on when it signs; what it cannot turn on, the publish answer lists under capabilityWarnings and the launcher shows on the app. Tell the user about those. Networking, WebSockets, and audio need nothing, except audio that keeps running when the phone locks (UIBackgroundModes in "infoPlist").
- Tell the user the build number, that it reaches TestFlight in a few minutes, and that https://{{rootDomain}}/apps shows when it is ready.

Nap data from an app, on every platform: the app cannot pass Cloudflare Access, so it uses a Nap token like an agent. Sign in with the device flow from the `api` topic: POST /\_nap/api/auth/device, open https://{{rootDomain}}/connect?code=<user_code> for the person to approve (on iOS in an ASWebAuthenticationSession or Safari), poll POST /\_nap/api/auth/token, and keep the token safe (the Keychain on iOS). Then send Authorization: Bearer <token> to https://{{rootDomain}}/\_nap/api/naps/<id>/data/<collection>[/<doc>], /live, /channel/<name> (WebSockets with the header), and /rtc (ICE servers for WebRTC). They work exactly like /\_nap/data, /\_nap/live, /\_nap/channel, and /\_nap/rtc on the nap's own host, so the app shares data and channels with the web version. GET /\_nap/api/people returns everyone's name and look (shape and colour), like nap.people() on the web. On 401 with code "invalid_token", sign in again; with "inactive", ask the person to open https://{{rootDomain}} in a browser.

In the commands, `nap-publish.mjs` is `/tmp/nap-publish.mjs` (see the main instructions).
