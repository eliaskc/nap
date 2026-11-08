import Foundation
import UIKit

/// A page on Nap, as its web pages see it: `Nap.site("weave")`. Its collections and channels
/// are the ones its web pages use.
@MainActor
@Observable
public final class NapSite {
  public let id: String
  /// Whether the live socket is open: changes arrive at once. Otherwise NapKit polls.
  public private(set) var live = false
  @ObservationIgnored private var collections: [String: any NapCollectionBase] = [:]
  @ObservationIgnored private var socket: URLSessionWebSocketTask?
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var retries = 0
  @ObservationIgnored private var rtcCache: NapRtc?

  /// Where collections keep their copies on the device.
  static let copies = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appending(path: "NapKit/\(Nap.origin.host() ?? "nap")")

  init(_ id: String) {
    self.id = id
    // Back from the background: the socket is gone, so reconnect and catch up.
    NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
  }

  /// /_nap/api/naps/<id>/<path>.
  public func url(_ path: String) -> URL { Nap.api("naps/\(id)/" + path) }

  /// The page's collections, like nap.db on the web.
  public var db: NapDB { NapDB(site: self) }

  /// A channel of the page, like nap.channel(name), with any JSON as messages. Call `leave()`
  /// when done.
  public func channel(_ name: String) -> NapChannel<JSONValue> { NapChannel(site: self, name: name) }

  /// Watches a channel without joining it: `peers` and their presence stay live, but nobody sees
  /// this device and it cannot send. For showing who is in a lobby, as a launcher does. Call
  /// `leave()` when done.
  public func watch(_ name: String) -> NapChannel<JSONValue> { NapChannel(site: self, name: name, watch: true) }

  /// A channel whose messages are one Codable type, such as an enum of a game's messages.
  /// Messages that do not decode as it are dropped.
  public func channel<M: Codable & Sendable>(_ name: String, messages: M.Type) -> NapChannel<M> {
    NapChannel(site: self, name: name)
  }

  /// ICE servers for WebRTC between people on this page: STUN, and TURN relays with short-lived
  /// credentials when the Nap has a TURN key. Kept until shortly before they expire.
  public func rtc() async throws -> NapRtc {
    if let cache = rtcCache, cache.expiresAt.map({ $0.timeIntervalSinceNow > 600 }) ?? false { return cache }
    let rtc: NapRtc = try await Nap.request("GET", url("rtc"))
    rtcCache = rtc
    return rtc
  }

  /// Fetches a URL through Nap, for APIs the page lists in its nap.json ("fetch"). Like nap.fetch.
  public func fetch(
    _ target: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil
  ) async throws -> (Data, HTTPURLResponse) {
    var url = URLComponents(url: url("fetch"), resolvingAgainstBaseURL: false)!
    url.queryItems = [.init(name: "url", value: target.absoluteString)]
    var sent: [String: String] = [:]
    if !headers.isEmpty, let data = try? JSONEncoder().encode(headers) {
      sent["x-nap-fetch-headers"] = String(decoding: data, as: UTF8.self)
    }
    let type = headers.first { $0.key.lowercased() == "content-type" }?.value
    let (data, response) = try await Nap.send(method, url.url!, body: body, contentType: type, headers: sent)
    if response.value(forHTTPHeaderField: "x-nap-fetch") == nil {
      try Nap.check(data, response)
      throw NapError(message: "Nap fetch failed", status: response.statusCode)
    }
    return (data, response)
  }

  /// A notification to everyone else who can see this page, on their phones and in browsers with
  /// notifications on. Never to the sender. `open` is where a tap goes: a path on the page's
  /// site (default its home) or a URL on this Nap. On phones with this launcher, a tap opens the
  /// app whose app.json names this site. Resolves with how many people it went to.
  @discardableResult
  public func notify(title: String, body: String? = nil, open: String? = nil) async throws -> Int {
    struct Sent: Decodable { var sent: Int }
    let sent: Sent = try await Nap.request(
      "POST", url("notify"), body: NapNotification(title: title, body: body, open: open))
    return sent.sent
  }

  /// One of the Nap's extensions (instance/extensions/<name>), for its Swift client in
  /// NapKit/Sources/Extensions.
  public func extensionKit(_ name: String) -> NapExtensionKit { NapExtensionKit(site: self, name: name) }

  // MARK: Live updates

  func collection<T>(_ name: String, of _: T.Type, keepCopy: Bool) -> NapCollection<T> {
    let key = "\(name)|\(String(reflecting: T.self))"
    let collection = collections[key] as? NapCollection<T> ?? NapCollection<T>(site: self, name: name)
    collections[key] = collection
    if keepCopy { collection.keepCopy() }
    return collection
  }

  private var watched: [any NapCollectionBase] { collections.values.filter(\.watched) }

  /// A collection started watching: connect, and poll as a safety net (often while the socket
  /// is down, rarely while it is up), like the web client.
  func watching() {
    connect()
    guard pollTask == nil else { return }
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(self?.live == true ? 30 : 3))
        guard let self else { return }
        for collection in self.watched { await collection.poll() }
      }
    }
  }

  /// A collection stopped watching: with none left, close the socket.
  func unwatched() {
    guard watched.isEmpty else { return }
    pollTask?.cancel()
    pollTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    live = false
  }

  /// Reconnects now and catches up, e.g. after the app was in the background.
  public func refresh() {
    guard !watched.isEmpty else { return }
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    live = false
    retries = 0
    connect()
    Task { for collection in watched { await collection.poll() } }
  }

  /// Signed out: forget every collection and its copy on the device.
  func forget() {
    for collection in collections.values { collection.forget() }
    unwatched()
    rtcCache = nil
  }

  private struct LiveHead: Decodable { var type: String; var collection: String? }

  private func connect() {
    guard socket == nil, let token = NapAccount.shared.token else { return }
    var url = URLComponents(url: url("live"), resolvingAgainstBaseURL: false)!
    url.scheme = url.scheme == "http" ? "ws" : "wss"
    var request = URLRequest(url: url.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let task = URLSession.shared.webSocketTask(with: request)
    socket = task
    task.resume()
    receive(task)
    // Open once a ping goes through; then a ping every 30 seconds keeps it open.
    task.sendPing { [weak self] error in
      let failed = error != nil
      Task { @MainActor in
        guard let self, self.socket === task, !failed else { return }
        self.live = true
        self.retries = 0
      }
    }
    Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        guard let self, self.socket === task else { return }
        task.send(.string("ping")) { _ in }
      }
    }
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.socket === task else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message, text != "pong" {
            let data = Data(text.utf8)
            if let head = try? JSONDecoder().decode(LiveHead.self, from: data), head.type == "change" {
              for collection in self.collections.values where collection.name == head.collection {
                collection.receive(data)
              }
            }
          }
          self.receive(task)
        case .failure:
          self.socket = nil
          self.live = false
          guard !self.watched.isEmpty else { return }
          let delay = min(30, pow(2, Double(self.retries))) * Double.random(in: 0.5...1)
          self.retries += 1
          Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !self.watched.isEmpty else { return }
            self.connect()
          }
        }
      }
    }
  }
}

/// A page's collections: `site.db.collection("games", of: Game.self)`.
@MainActor
public struct NapDB {
  let site: NapSite

  /// One object per collection, type and page, so every view sees the same documents.
  /// `keepCopy` keeps them on the device too: the next launch shows them at once.
  public func collection<T: Codable & Sendable>(_ name: String, of type: T.Type, keepCopy: Bool = false)
    -> NapCollection<T>
  {
    site.collection(name, of: type, keepCopy: keepCopy)
  }

  /// A collection of any JSON.
  public func collection(_ name: String, keepCopy: Bool = false) -> NapCollection<JSONValue> {
    site.collection(name, of: JSONValue.self, keepCopy: keepCopy)
  }
}

/// ICE servers for WebRTC, from `site.rtc()`.
public struct NapRtc: Decodable, Sendable {
  public struct Server: Decodable, Sendable {
    public var urls: [String]
    public var username: String?
    public var credential: String?

    private enum Keys: String, CodingKey { case urls, username, credential }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      if let one = try? c.decode(String.self, forKey: .urls) { urls = [one] } else {
        urls = try c.decode([String].self, forKey: .urls)
      }
      username = try c.decodeIfPresent(String.self, forKey: .username)
      credential = try c.decodeIfPresent(String.self, forKey: .credential)
    }
  }
  public var iceServers: [Server]
  /// Whether there are TURN relays, for networks where a direct path fails.
  public var turn: Bool
  public var expiresAt: Date?

  private enum Keys: String, CodingKey { case iceServers, turn, expiresAt }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    iceServers = try c.decode([Server].self, forKey: .iceServers)
    turn = try c.decodeIfPresent(Bool.self, forKey: .turn) ?? false
    expiresAt = (try c.decodeIfPresent(String.self, forKey: .expiresAt)).flatMap {
      let format = ISO8601DateFormatter()
      format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      return format.date(from: $0) ?? ISO8601DateFormatter().date(from: $0)
    }
  }
}

/// What an extension's Swift client gets: requests to /_nap/ext/<name>/ of the page.
@MainActor
public struct NapExtensionKit {
  let site: NapSite
  public let name: String

  public func request(
    _ path: String, method: String = "GET", body: Data? = nil, contentType: String? = "application/json"
  ) async throws -> (Data, HTTPURLResponse) {
    let trimmed = path.drop { $0 == "/" }
    return try await Nap.send(method, site.url("ext/\(name)/\(trimmed)"), body: body, contentType: contentType)
  }

  public func json<T: Decodable>(_ path: String, method: String = "GET", body: (any Encodable)? = nil) async throws -> T {
    let trimmed = path.drop { $0 == "/" }
    return try await Nap.request(method, site.url("ext/\(name)/\(trimmed)"), body: body)
  }
}
