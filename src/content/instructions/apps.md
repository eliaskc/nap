# iOS apps on Nap

Nap also hosts native iOS prototypes in SwiftUI, for things a web page cannot show, such as an onboarding flow that must feel native. People install them from https://{{rootDomain}}/apps on an iPhone registered with Nap. You need a Mac with Xcode, git, Node 20+, and Tuist (mise install, from the app's mise.toml). Nap signs the builds; you never sign anything.

- An app is a Git repo on Nap holding a Tuist project: one launcher app that lists every prototype, and one folder per prototype in Prototypes/<slug>/ (prototype.json, and Sources/ with a public struct PrototypeView: View). A prototype with "standalone": true in prototype.json is also its own app. Read the repo's AGENTS.md before you change it.
- Prefer adding a prototype to an existing app over making a new app. List them: node nap-publish.mjs app list
- Get an app's source: node nap-publish.mjs app clone <app> [dir]. Pull before you start (node nap-publish.mjs app run <app> -- git -C <dir> pull nap main), and run scripts/generate after every pull.
- New app: node nap-publish.mjs app init <app> [dir] --title 'Name'. It creates the repo from the template and pushes the first commit.
- Test in the Simulator while you work (xcodebuild -scheme Launcher -sdk iphonesimulator, or Xcode). Simulator builds cannot be published.
- Publish: commit, then scripts/publish launcher 'What changed, for testers' (or scripts/publish <slug> for a standalone prototype). It builds for iPhone without signing, pushes HEAD to main, and uploads the build with that commit. Nap signs it, gives it the next build number, and makes it live. People update from the app's page or the update prompt. Never force-push main.
- A publish answers 409 "source_not_head" when someone pushed after you: pull, build, and publish again. "source_not_descendant" means your history drops a published commit: merge it back in.
- No capabilities that need entitlements: push notifications, App Groups, iCloud, Sign in with Apple. Networking, WebSockets, and audio work.
- Nap data from the app: the app cannot pass Cloudflare Access, so it uses a Nap token like an agent. Sign in with the device flow from the `api` topic: POST /\_nap/api/auth/device, open https://{{rootDomain}}/connect?code=<user_code> in an ASWebAuthenticationSession (or Safari) for the person to approve, poll POST /\_nap/api/auth/token, and keep the token in the Keychain. Then send Authorization: Bearer <token> to https://{{rootDomain}}/\_nap/api/naps/<id>/data/<collection>[/<doc>], /live, and /channel/<name> (WebSockets: URLSessionWebSocketTask with the header). They work exactly like /\_nap/data, /\_nap/live, and /\_nap/channel on the nap's own host, so the app shares data and channels with the web version. On 401 with code "invalid_token", sign in again; with "inactive", ask the person to open https://{{rootDomain}} in Safari.
- Tell the user the build number and to install or update from https://{{rootDomain}}/apps on their iPhone.

In the commands, `nap-publish.mjs` is `/tmp/nap-publish.mjs` (see the main instructions).
