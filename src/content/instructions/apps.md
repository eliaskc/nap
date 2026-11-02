# iOS apps on Nap

Nap also hosts native iOS prototypes in SwiftUI, for things a web page cannot show, such as an onboarding flow that must feel native. You need a Mac with Xcode, git, Node 20+, and Tuist (mise install, from the app's mise.toml). Nap signs the builds; you never sign anything.

<!-- if testflight -->

People install the launcher of the app `{{testFlightApp}}` from TestFlight: Nap uploads each build of it to App Store Connect, Apple processes it for a few minutes, and testers install or update it in the TestFlight app. https://{{rootDomain}}/apps shows when a build is ready. Testers are added in App Store Connect; send people without access to {{admin}}.

<!-- /if -->

<!-- if adhoc -->

People install from https://{{rootDomain}}/apps on an iPhone registered with Nap.

<!-- /if -->

- An app is a Git repo on Nap holding a Tuist project: one launcher app that lists every prototype, and one folder per prototype in Prototypes/<slug>/ (prototype.json, and Sources/ with a public struct PrototypeView: View). Read the repo's AGENTS.md before you change it.

<!-- if adhoc -->

- A prototype with "standalone": true in prototype.json is also its own app, installed from https://{{rootDomain}}/apps. Publish it with scripts/publish <slug>.
- Prefer adding a prototype to an existing app over making a new app. List them: node nap-publish.mjs app list
- New app: node nap-publish.mjs app init <app> [dir] --title 'Name'. It creates the repo from the template and pushes the first commit.

<!-- /if -->

<!-- if testflight -->

- Add prototypes to the launcher of `{{testFlightApp}}`: it is what goes to TestFlight. Do not make prototypes "standalone" there.

<!-- /if -->

- Get an app's source: node nap-publish.mjs app clone <app> [dir]. Pull before you start (node nap-publish.mjs app run <app> -- git -C <dir> pull nap main), and run scripts/generate after every pull.
- Test in the Simulator while you work (xcodebuild -scheme Launcher -sdk iphonesimulator, or Xcode). Simulator builds cannot be published.
- Publish: commit, then scripts/publish launcher 'What changed, for testers'. It builds for iPhone without signing, pushes HEAD to main, and uploads the build with that commit. Nap signs it, gives it the next build number, and publishes it. Never force-push main.
- A publish answers 409 "source_not_head" when someone pushed after you: pull, build, and publish again. "source_not_descendant" means your history drops a published commit: merge it back in.
- Keep the launcher's app icon (Apps/Launcher/Resources) and ITSAppUsesNonExemptEncryption in Project.swift: TestFlight refuses builds without them.
- Permissions and capabilities go in the prototype's prototype.json, never in Project.swift: "permissions" are Info.plist usage strings ({"NSCameraUsageDescription": "Why, in a sentence"}), and "capabilities" are names such as ["push-notifications", "healthkit"]. The app's AGENTS.md lists them. Nap turns capabilities on when it signs a TestFlight build (ad hoc builds get none); what it cannot turn on, the publish answer lists under capabilityWarnings and the launcher shows on the prototype. Tell the user about those. Networking, WebSockets, and audio need nothing.
- Nap data from the app: the app cannot pass Cloudflare Access, so it uses a Nap token like an agent. Sign in with the device flow from the `api` topic: POST /\_nap/api/auth/device, open https://{{rootDomain}}/connect?code=<user_code> in an ASWebAuthenticationSession (or Safari) for the person to approve, poll POST /\_nap/api/auth/token, and keep the token in the Keychain. Then send Authorization: Bearer <token> to https://{{rootDomain}}/\_nap/api/naps/<id>/data/<collection>[/<doc>], /live, /channel/<name> (WebSockets: URLSessionWebSocketTask with the header), and /rtc (ICE servers for WebRTC). They work exactly like /\_nap/data, /\_nap/live, /\_nap/channel, and /\_nap/rtc on the nap's own host, so the app shares data and channels with the web version. On 401 with code "invalid_token", sign in again; with "inactive", ask the person to open https://{{rootDomain}} in Safari.

<!-- if testflight -->

- Tell the user the build number, that it reaches TestFlight in a few minutes, and that https://{{rootDomain}}/apps shows when it is ready.

<!-- /if -->

<!-- if adhoc -->

- Tell the user the build number and to install or update from https://{{rootDomain}}/apps on their iPhone.

<!-- /if -->

In the commands, `nap-publish.mjs` is `/tmp/nap-publish.mjs` (see the main instructions).
