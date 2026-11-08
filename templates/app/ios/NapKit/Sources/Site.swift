import Foundation
import UIKit

/// A page on Nap, as its web pages see it: `Nap.site("weave")`. Its collections and channels
/// are the ones its web pages use.
@MainActor
public final class NapSite {
  public let id: String
  private var collections: [String: NapCollection] = [:]
  private var socket: URLSessionWebSocketTask?
  private var liveOpen = false
  private var pollTask: Task<Void, Never>?
  private var retries = 0

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

  /// A channel of the page, like nap.channel(name). Call `leave()` when done.
  public func channel(_ name: String) -> NapChannel { NapChannel(site: self, name: name) }

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

  func collection(_ name: String) -> NapCollection {
    if let collection = collections[name] { return collection }
    let collection = NapCollection(site: self, name: name)
    collections[name] = collection
    return collection
  }

  /// A collection started watching: connect, and poll as a safety net (often while the socket
  /// is down, rarely while it is up), like the web client.
  func watching() {
    connect()
    guard pollTask == nil else { return }
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(self?.liveOpen == true ? 30 : 3))
        guard let self else { return }
        for collection in self.collections.values where collection.watched { await collection.poll() }
      }
    }
  }

  /// Reconnects now and catches up, e.g. after the app was in the background.
  public func refresh() {
    guard collections.values.contains(where: \.watched) else { return }
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    liveOpen = false
    retries = 0
    connect()
    Task { for collection in collections.values where collection.watched { await collection.poll() } }
  }

  private struct LiveMessage: Decodable { var type: String; var collection: String?; var change: NapDocument? }

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
        self.liveOpen = true
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
          if case .string(let text) = message, text != "pong",
            let live = try? JSONDecoder().decode(LiveMessage.self, from: Data(text.utf8)),
            live.type == "change", let name = live.collection, let change = live.change
          {
            self.collections[name]?.apply(change)
          }
          self.receive(task)
        case .failure:
          self.socket = nil
          self.liveOpen = false
          let delay = min(30, pow(2, Double(self.retries))) * Double.random(in: 0.5...1)
          self.retries += 1
          Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            self?.connect()
          }
        }
      }
    }
  }
}

/// A page's collections: `site.db.collection("games")`.
@MainActor
public struct NapDB {
  let site: NapSite
  /// One object per collection and page, so every view sees the same documents.
  public func collection(_ name: String) -> NapCollection { site.collection(name) }
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
