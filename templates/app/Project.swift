import Foundation
import ProjectDescription

// Every folder in Prototypes/ is a prototype: a module with a PrototypeView, shown in the launcher.
// A prototype with "standalone": true in its prototype.json is also its own app.
// Nap sets the real bundle id and build number when it signs, so the ids here are placeholders.

struct Manifest: Decodable {
  var title: String?
  var standalone: Bool?
}

struct Prototype {
  var slug: String
  var title: String
  var standalone: Bool
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let prototypes: [Prototype] = (
  (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Prototypes").path)) ?? []
)
.filter { !$0.hasPrefix(".") }
.sorted()
.compactMap { slug in
  let file = root.appendingPathComponent("Prototypes/\(slug)/prototype.json")
  guard let data = try? Data(contentsOf: file),
        let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return nil }
  return Prototype(slug: slug, title: manifest.title ?? slug, standalone: manifest.standalone ?? false)
}

func moduleName(_ slug: String) -> String { "Proto_" + slug.replacingOccurrences(of: "-", with: "_") }

let ios: DeploymentTargets = .iOS("18.0")
// iPhone only, and no encryption beyond HTTPS: TestFlight needs both answered (iPad apps need
// iPad icons and every orientation; the encryption key saves a question in App Store Connect).
let iPhone: Destinations = [.iPhone]
let orientations: Plist.Value = [
  "UIInterfaceOrientationPortrait",
  "UIInterfaceOrientationLandscapeLeft",
  "UIInterfaceOrientationLandscapeRight",
]

let modules: [Target] = prototypes.map { prototype in
  .target(
    name: moduleName(prototype.slug),
    destinations: .iOS,
    product: .staticFramework,
    bundleId: "nap.prototype.\(prototype.slug)",
    deploymentTargets: ios,
    sources: ["Prototypes/\(prototype.slug)/Sources/**"],
    resources: ["Prototypes/\(prototype.slug)/Resources/**"]
  )
}

let launcher: Target = .target(
  name: "Launcher",
  destinations: iPhone,
  product: .app,
  productName: "Nap",
  bundleId: "nap.launcher",
  deploymentTargets: ios,
  infoPlist: .extendingDefault(with: [
    "UILaunchScreen": [:],
    "CFBundleDisplayName": "Nap",
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "1",
    "ITSAppUsesNonExemptEncryption": false,
    "UISupportedInterfaceOrientations": orientations,
  ]),
  sources: ["Apps/Launcher/Sources/**", "Generated/Launcher/**"],
  // The app icon: TestFlight refuses builds without one. Replace icon.png (1024 x 1024, no alpha).
  resources: ["Apps/Launcher/Resources/**"],
  dependencies: prototypes.map { .target(name: moduleName($0.slug)) }
)

let standalone: [Target] = prototypes.filter(\.standalone).map { prototype in
  .target(
    name: "Standalone_" + prototype.slug.replacingOccurrences(of: "-", with: "_"),
    destinations: iPhone,
    product: .app,
    productName: prototype.slug,
    bundleId: "nap.\(prototype.slug)",
    deploymentTargets: ios,
    infoPlist: .extendingDefault(with: [
      "UILaunchScreen": [:],
      "CFBundleDisplayName": .string(prototype.title),
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
      "ITSAppUsesNonExemptEncryption": false,
      "UISupportedInterfaceOrientations": orientations,
    ]),
    sources: ["Generated/Standalone/\(prototype.slug)/**"],
    dependencies: [.target(name: moduleName(prototype.slug))]
  )
}

let project = Project(
  name: "NapApps",
  settings: .settings(base: [
    // Fast device builds: content-keyed compilation cache, no dSYMs, no preview dylib.
    "COMPILATION_CACHE_ENABLE_CACHING": "YES",
    "DEBUG_INFORMATION_FORMAT": "dwarf",
    "ENABLE_DEBUG_DYLIB": "NO",
    "ONLY_ACTIVE_ARCH": "YES",
    "SWIFT_VERSION": "6.0",
  ]),
  targets: modules + [launcher] + standalone
)
