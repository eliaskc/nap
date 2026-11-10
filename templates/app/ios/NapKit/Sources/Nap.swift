import Foundation

// NapKit: what a web page on Nap gets as window.nap, for the apps in this launcher. Nap serves
// it with the template and `scripts/napkit` updates it: never edit these files here.
//
//   let weave = Nap.site("weave")                 // a page on Nap, by its id
//   weave.db.collection("games")                  // its collections, live (nap.db.collection)
//   weave.channel("room")                         // its channels (nap.channel)
//   try await weave.fetch(url)                    // nap.fetch
//   try await weave.notify(title: "Elias wants to play")   // nap.notify
//   try await Nap.me(), Nap.people()              // nap.me(), nap.people()
//   Nap.account                                   // the sign-in, shared by every app
//
// Apps cannot pass Cloudflare Access, so NapKit signs in once per launcher (the device flow) and
// sends that Nap token to /_nap/api. A page's data, channels, and live updates there are the same
// ones its web pages use, so the app and the site share them.

/// The Nap this launcher belongs to, and what is not about one page.
@MainActor
public enum Nap {
  /// Override for a local Nap with the launch argument `-nap-url http://localhost:1337`.
  public static var origin: URL {
    if let custom = UserDefaults.standard.string(forKey: "nap-url"), let url = URL(string: custom) {
      return url
    }
    return URL(string: "https://{{rootDomain}}")!
  }

  /// The sign-in: one for every app in the launcher.
  public static var account: NapAccount { NapAccount.shared }

  private static var sites: [String: NapSite] = [:]

  /// A page on Nap by its id (a site's slug), with its collections, channels, fetch, and notify.
  public static func site(_ id: String) -> NapSite {
    if let site = sites[id] { return site }
    let site = NapSite(id)
    sites[id] = site
    return site
  }

  /// The person signed in, with their name and look. Like nap.me().
  public static func me() async throws -> NapPerson {
    try await request("GET", api("me"))
  }

  /// Everyone on this Nap, or only these emails, with their names and looks. Like nap.people().
  public static func people(_ emails: [String]? = nil) async throws -> [NapPerson] {
    struct People: Decodable { var people: [NapPerson] }
    var url = URLComponents(url: api("people"), resolvingAgainstBaseURL: false)!
    if let emails { url.queryItems = [.init(name: "emails", value: emails.joined(separator: ","))] }
    let result: People = try await request("GET", url.url!)
    return result.people
  }

  /// Whether this Nap sends notifications. Show what sends one only when it does.
  public static func canNotify() async -> Bool {
    struct Enabled: Decodable { var enabled: Bool }
    let result: Enabled? = try? await request("GET", api("notify"))
    return result?.enabled ?? false
  }

  /// A notification from an app with no page of its own, to everyone else on this Nap with the
  /// app or notifications on. `app` is its folder in Apps/, so a tap opens it. Apps that play
  /// with a site use `Nap.site(id).notify` instead. Resolves with how many people it went to.
  @discardableResult
  public static func notify(title: String, body: String? = nil, open: String? = nil, app: String? = nil) async throws -> Int {
    struct Sent: Decodable { var sent: Int }
    let sent: Sent = try await request(
      "POST", api("notify"), body: NapNotification(title: title, body: body, open: open, app: app))
    return sent.sent
  }

  /// Signing out: forget every page's data, and the copies on the device.
  static func forget() {
    for site in sites.values { site.forget() }
    try? FileManager.default.removeItem(at: NapSite.copies)
  }

  // MARK: HTTP

  /// /_nap/api/<path> on this Nap.
  public static func api(_ path: String) -> URL { origin.appendingPathComponent("_nap/api/" + path) }

  /// A request with the Nap token. Failures become a NapError; a lost token signs out.
  public static func send(
    _ method: String, _ url: URL, body: Data? = nil, contentType: String? = "application/json",
    headers: [String: String] = [:], auth: Bool = true
  ) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 20
    if let body {
      request.httpBody = body
      if let contentType { request.setValue(contentType, forHTTPHeaderField: "content-type") }
    }
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    if auth, let token = NapAccount.shared.token {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    return (data, response as? HTTPURLResponse ?? HTTPURLResponse())
  }

  /// A JSON request: encodes `body`, checks the status, and decodes the answer.
  public static func request<T: Decodable>(
    _ method: String, _ url: URL, body: (any Encodable)? = nil, headers: [String: String] = [:],
    auth: Bool = true
  ) async throws -> T {
    let data = try body.map { try JSONEncoder().encode($0) }
    let (answer, response) = try await send(method, url, body: data, headers: headers, auth: auth)
    try check(answer, response)
    return try JSONDecoder().decode(T.self, from: answer)
  }

  /// Throws the NapError for a failed response.
  static func check(_ data: Data, _ response: HTTPURLResponse) throws {
    let status = response.statusCode
    guard !(200..<300).contains(status) else { return }
    struct Failure: Decodable {
      var error: String?
      var error_description: String?
      var code: String?
      var document: NapDocument<JSONValue>?
    }
    let failure = try? JSONDecoder().decode(Failure.self, from: data)
    let error = NapError(
      message: failure?.error_description ?? failure?.error ?? "Nap answered \(status)",
      code: failure?.code, status: status, document: failure?.document)
    if status == 401 { NapAccount.shared.refused(error) }
    throw error
  }
}

struct NapNotification: Encodable {
  var title: String
  var body: String?
  var open: String?
  var app: String?
  var skip: [String]?
}

/// What Nap answered when a request failed. `status` is the HTTP status; `document` is the
/// current version when a write lost to someone else's (409).
public struct NapError: Error, LocalizedError, Sendable {
  public var message: String
  public var code: String?
  public var status: Int
  public var document: NapDocument<JSONValue>?
  public init(message: String, code: String? = nil, status: Int, document: NapDocument<JSONValue>? = nil) {
    self.message = message
    self.code = code
    self.status = status
    self.document = document
  }
  public var errorDescription: String? { message }
  /// The sign-in is gone: NapKit has signed out.
  public var signedOut: Bool { status == 401 && code == "invalid_token" }
  /// The person must open Nap in a browser once before the app may use it.
  public var inactive: Bool { status == 401 && code == "inactive" }
}

/// Someone on Nap, with the look the web draws them with.
public struct NapPerson: Codable, Hashable, Sendable {
  public var email: String
  public var name: String
  public var shape: String?
  public var color: String?
  public var firstName: String { name.split(separator: " ").first.map(String.init) ?? name }
  public init(email: String, name: String, shape: String? = nil, color: String? = nil) {
    self.email = email
    self.name = name
    self.shape = shape
    self.color = color
  }
}

// MARK: - JSON

/// Any JSON value: documents, presence, and messages that are not one Codable type.
public enum JSONValue: Codable, Equatable, Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let v = try? c.decode(Bool.self) { self = .bool(v) }
    else if let v = try? c.decode(Double.self) { self = .number(v) }
    else if let v = try? c.decode(String.self) { self = .string(v) }
    else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .number(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }
  public var string: String? { if case .string(let s) = self { return s }; return nil }
  public var number: Double? { if case .number(let n) = self { return n }; return nil }
  public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }

  /// Through JSON, to a Codable type.
  public func decode<T: Decodable>(_: T.Type = T.self) -> T? {
    guard let data = try? JSONEncoder().encode(self) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }
  public static func from(_ value: some Encodable) -> JSONValue {
    if let json = value as? JSONValue { return json }
    let data = (try? JSONEncoder().encode(value)) ?? Data("null".utf8)
    return (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null
  }
}

// MARK: - Keychain

enum Keychain {
  static let service = "nap"
  static func read(_ account: String, service: String = service) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account, kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }
  static func write(_ account: String, _ value: String?) {
    let base: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(base as CFDictionary)
    guard let value else { return }
    var add = base
    add[kSecValueData as String] = Data(value.utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    SecItemAdd(add as CFDictionary, nil)
  }
}
