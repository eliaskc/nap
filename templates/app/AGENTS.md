# {{title}}

The native apps of {{title}} on Nap, in one repo with a folder per platform. Each platform has a
launcher that holds every app made for it, and Nap publishes each platform on its own.

- `ios/`: SwiftUI apps in one launcher, signed by Nap and installed from TestFlight. Read
  `ios/AGENTS.md` before you change it.
- `nap.json` names the app on Nap.

An app can exist on one platform or several. On each, it is a folder named after its slug, so the
same slug means the same app everywhere.

Publishing a platform pushes HEAD to main of this repo on Nap and uploads that platform's build
with the commit. Nap only takes a build of the head of main that contains the commit of that
platform's live build. If someone pushed first, pull, merge, and publish again. Never force-push
main.
