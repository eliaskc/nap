import Foundation
import ProjectDescription

// Every folder in Apps/ is an app: a module with a public AppView, shown in the launcher.
// The launcher is the one iOS app Nap publishes, to TestFlight. Nap sets the real bundle id and
// build number when it signs, so the ids here are placeholders.
//
// app.json also declares what the app needs, and the launcher gets it from there:
// - "permissions": Info.plist usage strings, such as {"NSCameraUsageDescription": "…"}.
// - "capabilities": such as ["push-notifications"]. They go into Info.plist as NapCapabilities,
//   by app; Nap turns them on when it signs, and the launcher warns about any it could not.
// - "infoPlist": any other Info.plist keys, such as {"UIBackgroundModes": ["audio"]}. Lists from
//   several apps are combined; for other values the first app (by slug) wins. Keys this file
//   sets itself, such as the bundle version, cannot be changed.
// - "site": the page on Nap the app plays with (its id), so a tap on that page's notification
//   opens the app.
// - "packages": Swift packages, [{ "url": "…", "version": "1.2.3", "products": ["Name"] }].
// - "frameworks": prebuilt .xcframeworks the app links, as paths inside its folder, such as
//   ["Frameworks/SleepCycleSDK.xcframework"]. Commit them; the launcher embeds them.

/// The launcher's name on the home screen.
let displayName = "{{title}}"

struct Manifest: Decodable {
  var title: String?
  var permissions: [String: String]?
  var capabilities: [String]?
  var infoPlist: [String: PlistJSON]?
  var frameworks: [String]?
  var packages: [PackageRef]?
}

struct PackageRef: Decodable {
  var url: String
  var version: String
  var products: [String]
}

/// A JSON value from app.json, turned into an Info.plist value.
indirect enum PlistJSON: Decodable {
  case string(String), bool(Bool), integer(Int), real(Double), array([PlistJSON]), dictionary([String: PlistJSON])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let value = try? container.decode(Bool.self) { self = .bool(value) }
    else if let value = try? container.decode(Int.self) { self = .integer(value) }
    else if let value = try? container.decode(Double.self) { self = .real(value) }
    else if let value = try? container.decode(String.self) { self = .string(value) }
    else if let value = try? container.decode([PlistJSON].self) { self = .array(value) }
    else { self = .dictionary(try container.decode([String: PlistJSON].self)) }
  }

  var plist: Plist.Value {
    switch self {
    case let .string(value): .string(value)
    case let .bool(value): .boolean(value)
    case let .integer(value): .integer(value)
    case let .real(value): .real(value)
    case let .array(values): .array(values.map(\.plist))
    case let .dictionary(values): .dictionary(values.mapValues(\.plist))
    }
  }
}

struct NapApp {
  var slug: String
  var title: String
  var permissions: [String: String]
  var capabilities: [String]
  var infoPlist: [String: PlistJSON]
  var packages: [PackageRef]
  var frameworks: [String]
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

let apps: [NapApp] = (
  (try? FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("Apps").path)) ?? []
)
.filter { !$0.hasPrefix(".") }
.sorted()
.compactMap { slug in
  let file = root.appendingPathComponent("Apps/\(slug)/app.json")
  guard let data = try? Data(contentsOf: file),
        let manifest = try? JSONDecoder().decode(Manifest.self, from: data) else { return nil }
  return NapApp(
    slug: slug,
    title: manifest.title ?? slug,
    permissions: manifest.permissions ?? [:],
    capabilities: manifest.capabilities ?? [],
    infoPlist: manifest.infoPlist ?? [:],
    packages: manifest.packages ?? [],
    frameworks: manifest.frameworks ?? []
  )
}

/// Usage strings, other Info.plist keys, and capability requests for a launcher made of these
/// apps. Lists are combined; otherwise the first app (by slug) wins.
func declared(_ apps: [NapApp]) -> [String: Plist.Value] {
  var plist: [String: Plist.Value] = [:]
  for app in apps {
    for (key, text) in app.permissions where plist[key] == nil {
      plist[key] = .string(text)
    }
    for (key, value) in app.infoPlist where key != "NapCapabilities" {
      switch (plist[key], value.plist) {
      case let (.array(existing)?, .array(added)):
        plist[key] = .array(existing + added.filter { !existing.contains($0) })
      case (nil, let added):
        plist[key] = added
      default:
        break
      }
    }
  }
  let requests = apps.filter { !$0.capabilities.isEmpty }
  if !requests.isEmpty {
    plist["NapCapabilities"] = .dictionary(Dictionary(uniqueKeysWithValues: requests.map {
      ($0.slug, Plist.Value.array($0.capabilities.map { .string($0) }))
    }))
  }
  return plist
}

func moduleName(_ slug: String) -> String { "App_" + slug.replacingOccurrences(of: "-", with: "_") }

let ios: DeploymentTargets = .iOS("18.0")
// iPhone and iPad, and no encryption beyond HTTPS (the encryption key saves a question in App Store
// Connect). iPad apps need iPad icons (Icon Composer's AppIcon.icon makes them) and every orientation.
let devices: Destinations = [.iPhone, .iPad]
let orientations: Plist.Value = [
  "UIInterfaceOrientationPortrait",
  "UIInterfaceOrientationLandscapeLeft",
  "UIInterfaceOrientationLandscapeRight",
]

/// NapKit: window.nap for Swift (NapKit/Sources, from Nap: scripts/napkit updates it). Every app
/// and the launcher link it.
let napKit: Target = .target(
  name: "NapKit",
  destinations: .iOS,
  product: .staticFramework,
  bundleId: "nap.kit",
  deploymentTargets: ios,
  sources: ["NapKit/Sources/**"]
)

let modules: [Target] = apps.map { app in
  .target(
    name: moduleName(app.slug),
    destinations: .iOS,
    product: .staticFramework,
    bundleId: "nap.app.\(app.slug)",
    deploymentTargets: ios,
    sources: ["Apps/\(app.slug)/Sources/**"],
    resources: ["Apps/\(app.slug)/Resources/**"],
    dependencies: [.target(name: "NapKit")]
      + app.packages.flatMap { $0.products.map { TargetDependency.package(product: $0) } }
      + app.frameworks.map { .xcframework(path: "Apps/\(app.slug)/\($0)") }
  )
}

/// Every app's packages, once each (the first version named wins).
var seenPackages = Set<String>()
let packages: [Package] = apps.flatMap(\.packages).compactMap { ref in
  guard seenPackages.insert(ref.url).inserted else { return nil }
  return .remote(url: ref.url, requirement: .exact(Version(stringLiteral: ref.version)))
}

let launcher: Target = .target(
  name: "Launcher",
  destinations: devices,
  product: .app,
  productName: "Nap",
  bundleId: "nap.launcher",
  deploymentTargets: ios,
  infoPlist: .extendingDefault(with: declared(apps).merging([
    "UILaunchScreen": [:],
    "CFBundleDisplayName": .string(displayName),
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "1",
    "ITSAppUsesNonExemptEncryption": false,
    "UISupportedInterfaceOrientations": orientations,
    "UISupportedInterfaceOrientations~ipad": [
      "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
    ],
  ]) { _, fixed in fixed }),
  sources: ["Launcher/Sources/**", "Generated/Launcher/**"],
  // The app icon, Resources/AppIcon.icon (Icon Composer): TestFlight refuses builds without one.
  resources: ["Launcher/Resources/**"],
  dependencies: [.target(name: "NapKit")] + apps.map { .target(name: moduleName($0.slug)) }
)

let project = Project(
  name: "NapApps",
  packages: packages,
  settings: .settings(base: [
    // Fast device builds: content-keyed compilation cache, no dSYMs, no preview dylib.
    "COMPILATION_CACHE_ENABLE_CACHING": "YES",
    "DEBUG_INFORMATION_FORMAT": "dwarf",
    "ENABLE_DEBUG_DYLIB": "NO",
    "ONLY_ACTIVE_ARCH": "YES",
    "SWIFT_VERSION": "6.0",
  ]),
  targets: [napKit] + modules + [launcher]
)
