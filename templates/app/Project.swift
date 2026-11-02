import Foundation
import ProjectDescription

// Every folder in Prototypes/ is a prototype: a module with a PrototypeView, shown in the launcher.
// A prototype with "standalone": true in its prototype.json is also its own app.
// Nap sets the real bundle id and build number when it signs, so the ids here are placeholders.
//
// prototype.json also declares what the prototype needs, and the app gets it from there:
// - "permissions": Info.plist usage strings, such as {"NSCameraUsageDescription": "…"}.
// - "capabilities": such as ["push-notifications"]. They go into Info.plist as NapCapabilities,
//   by prototype; Nap turns them on when it signs, and the launcher warns about any it could not.
// - "infoPlist": any other Info.plist keys, such as {"UIBackgroundModes": ["audio"]}. Lists from
//   several prototypes are combined; for other values the first prototype (by slug) wins. Keys
//   this file sets itself, such as the bundle version, cannot be changed.

struct Manifest: Decodable {
  var title: String?
  var standalone: Bool?
  var permissions: [String: String]?
  var capabilities: [String]?
  var infoPlist: [String: PlistJSON]?
}

/// A JSON value from prototype.json, turned into an Info.plist value.
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

struct Prototype {
  var slug: String
  var title: String
  var standalone: Bool
  var permissions: [String: String]
  var capabilities: [String]
  var infoPlist: [String: PlistJSON]
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
  return Prototype(
    slug: slug,
    title: manifest.title ?? slug,
    standalone: manifest.standalone ?? false,
    permissions: manifest.permissions ?? [:],
    capabilities: manifest.capabilities ?? [],
    infoPlist: manifest.infoPlist ?? [:]
  )
}

/// Usage strings, other Info.plist keys, and capability requests for an app made of these
/// prototypes. Lists are combined; otherwise the first prototype (by slug) wins.
func declared(_ prototypes: [Prototype]) -> [String: Plist.Value] {
  var plist: [String: Plist.Value] = [:]
  for prototype in prototypes {
    for (key, text) in prototype.permissions where plist[key] == nil {
      plist[key] = .string(text)
    }
    for (key, value) in prototype.infoPlist where key != "NapCapabilities" {
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
  let requests = prototypes.filter { !$0.capabilities.isEmpty }
  if !requests.isEmpty {
    plist["NapCapabilities"] = .dictionary(Dictionary(uniqueKeysWithValues: requests.map {
      ($0.slug, Plist.Value.array($0.capabilities.map { .string($0) }))
    }))
  }
  return plist
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
  infoPlist: .extendingDefault(with: declared(prototypes).merging([
    "UILaunchScreen": [:],
    "CFBundleDisplayName": "Nap",
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "1",
    "ITSAppUsesNonExemptEncryption": false,
    "UISupportedInterfaceOrientations": orientations,
  ]) { _, fixed in fixed }),
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
    infoPlist: .extendingDefault(with: declared([prototype]).merging([
      "UILaunchScreen": [:],
      "CFBundleDisplayName": .string(prototype.title),
      "CFBundleShortVersionString": "1.0",
      "CFBundleVersion": "1",
      "ITSAppUsesNonExemptEncryption": false,
      "UISupportedInterfaceOrientations": orientations,
    ]) { _, fixed in fixed }),
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
