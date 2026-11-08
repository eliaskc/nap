# Native apps on Nap

Nap also hosts native apps, for things a web page cannot do, such as an onboarding flow that must feel native or a game that should feel at home on the phone. Nap publishes them; you never sign anything.

This Nap has one app on Nap, `{{napApp}}`: one Git repo with a folder per platform. On each platform, a launcher holds every app made for it, and Nap publishes each platform on its own. An app is a folder named after its slug on each platform it is on. Platforms here:

<!-- if ios -->

- `ios/`: SwiftUI, in a launcher that people install from TestFlight. Needs a Mac with Xcode, git, Node 20+, and Tuist (mise install, from ios/mise.toml).

<!-- /if -->

<!-- if remarkable -->

- `remarkable/`: QML, in a launcher for the reMarkable 2 e-ink tablet, run by the community AppLoad launcher. Installed over USB once; it updates itself from Nap after that. Needs a Mac with git, Node 20+, Go and uv (mise install, from remarkable/mise.toml).

<!-- /if -->

Working on the repo:

- Get the source: node nap-publish.mjs app clone {{napApp}} [dir]. Pull before you start (node nap-publish.mjs app run {{napApp}} -- git -C <dir> pull nap main). If it does not exist yet, create it from the template once: node nap-publish.mjs app init {{napApp}} [dir] --title 'Name'.
- Read the repo's AGENTS.md, and the platform's (such as ios/AGENTS.md), before you change it.
- A new app is a new folder on each platform it is on, with the same slug: copy the platform's template app, hello (ios/Apps/hello on iOS). Never make a second app on Nap.
- A publish answers 409 "source_not_head" when someone pushed after you: pull, build, and publish again. "source_not_descendant" means your history drops a published commit: merge it back in. Never force-push main.

<!-- if ios -->

iOS:

- The project is ios/: the launcher in ios/Launcher/, and one folder per app in ios/Apps/<slug>/ (app.json, and Sources/ with a public struct AppView: View). Run ios/scripts/generate after every pull.
- Nap data from Swift: NapKit (ios/NapKit, linked by every app; import NapKit). It is window.nap for Swift: Nap.site("<id>") gives a page's db.collection(name, of: T.self) (typed, observable, live with watch(), and kept on the phone with keepCopy: true), channel(name, messages: M.self), rtc() (ICE servers for WebRTC), fetch, and notify; Nap.me() and Nap.people(); Nap.account is the launcher's one sign-in, so apps never sign in themselves (show NapSignInButton() where an app needs someone signed in). Never edit ios/NapKit: ios/scripts/napkit updates it from Nap. ios/AGENTS.md has examples. Put "site": "<id>" in app.json when the app plays with a page, so that page's notifications open the app.
- Test in the Simulator while you work (xcodebuild -scheme Launcher -sdk iphonesimulator in ios/, or Xcode). Simulator builds cannot be published.
- Publish: commit, then ios/scripts/publish 'What changed, for testers'. It builds the launcher for iPhone without signing, pushes HEAD to main, and uploads the build with that commit. Nap signs it, gives it the next build number, and uploads it to App Store Connect; Apple processes it for a few minutes, and testers install or update it in the TestFlight app. People get it from Get the app on the dashboard; send anyone who cannot to {{admin}}.
- Keep the launcher's app icon (ios/Launcher/Resources) and ITSAppUsesNonExemptEncryption in ios/Project.swift: TestFlight refuses builds without them.
- Permissions, capabilities, and other Info.plist keys go in the app's app.json, never in Project.swift: "permissions" are Info.plist usage strings ({"NSCameraUsageDescription": "Why, in a sentence"}), "infoPlist" holds any other keys ({"UIBackgroundModes": ["audio"], "NSBonjourServices": ["_my-app._tcp"]}), and "capabilities" are names such as ["push-notifications", "healthkit"]. ios/AGENTS.md lists them. Nap turns capabilities on when it signs; what it cannot turn on, the publish answer lists under capabilityWarnings and the launcher shows on the app. Tell the user about those. Networking, WebSockets, and audio need nothing, except audio that keeps running when the phone locks (UIBackgroundModes in "infoPlist").
- Tell the user the build number, that it reaches TestFlight in a few minutes, and that Get the app at https://{{rootDomain}}/app shows when it is ready. The title and summary in each app's app.json are what the dashboard lists as inside the build, so keep them short and true.

<!-- /if -->

<!-- if remarkable -->

reMarkable:

- The project is remarkable/: the launcher in remarkable/launcher/ (QML for Qt 6, and a Go backend in remarkable/backend/ for sign-in, sockets, handwriting, and updates), and one folder per app in remarkable/apps/<slug>/ (app.json and Main.qml). remarkable/AGENTS.md says how to write an app, the pen, and designing for e-ink.
- Test on the Mac while you work: remarkable/scripts/preview [--app <slug>] runs the launcher in a window with the real backend, and can take screenshots and drive the pen from a script. With a tablet plugged in by USB, remarkable/scripts/install puts a build on it, and remarkable/scripts/rmshot and remarkable/scripts/rminput look at and drive it.
- Publish: commit, then remarkable/scripts/publish 'What changed'. It builds the AppLoad folder, pushes HEAD to main, and uploads the zip with that commit; Nap gives it the next build number and makes it live. Tablets pick it up the next time the launcher opens, or with Check for updates. The first install on a tablet is over USB (remarkable/scripts/install); the tablet needs xovi and AppLoad.
- The launcher updates itself from GET /\_nap/api/apps/{{napApp}}/targets/remarkable (the live build, with sha256 and download, a path to GET with the token).
- Nap data: the launcher signs in with the device flow below (showing a QR code) and keeps the token; apps use its Nap client, host.nap(site), with the same calls as window.nap on the web.
- Tell the user the build number, and that tablets get it the next time the launcher opens.

<!-- /if -->

Nap data from an app, on every platform (NapKit and the launchers already do this): the app cannot pass Cloudflare Access, so it uses a Nap token like an agent. Sign in with the device flow from the `api` topic: POST /\_nap/api/auth/device, open https://{{rootDomain}}/connect?code=<user_code> for the person to approve (on iOS in an ASWebAuthenticationSession or Safari), poll POST /\_nap/api/auth/token, and keep the token safe (the Keychain on iOS). Then send Authorization: Bearer <token> to https://{{rootDomain}}/\_nap/api/naps/<id>/data/<collection>[/<doc>], /live, /channel/<name> (WebSockets with the header), and /rtc (ICE servers for WebRTC). They work exactly like /\_nap/data, /\_nap/live, /\_nap/channel, and /\_nap/rtc on the nap's own host, so the app shares data and channels with the web version. GET /\_nap/api/people returns everyone's name and look (shape and colour), like nap.people() on the web. On 401 with code "invalid_token", sign in again; with "inactive", ask the person to open https://{{rootDomain}} in a browser.

<!-- if notifications -->

Notifications from an app: POST /\_nap/api/naps/<id>/notify with { "title", "body", "open" } is nap.notify for that page (in Swift, Nap.site(id).notify(title:body:open:)). An app with no page of its own posts to /\_nap/api/notify with "app": its folder, which a tap opens (Nap.notify(title:body:open:app:)). The `notifications` topic says what to send. The iOS launcher registers for them itself once someone is signed in.

<!-- /if -->

In the commands, `nap-publish.mjs` is `/tmp/nap-publish.mjs` (see the main instructions).
