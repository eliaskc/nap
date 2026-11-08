import Foundation

/// Someone in a channel: a web page or an app. `state` is their presence.
public struct NapPeer: Decodable, Identifiable, Sendable {
  public var id: String
  public var email: String
  public var name: String
  public var shape: String?
  public var color: String?
  public var joinedAt: Double
  public var state: JSONValue?
  /// This device's own connection.
  public var isSelf = false

  private enum CodingKeys: String, CodingKey { case id, email, name, shape, color, joinedAt, state }

  public init(
    id: String, email: String, name: String, shape: String? = nil, color: String? = nil,
    joinedAt: Double = 0, state: JSONValue? = nil, isSelf: Bool = false
  ) {
    self.id = id
    self.email = email
    self.name = name
    self.shape = shape
    self.color = color
    self.joinedAt = joinedAt
    self.state = state
    self.isSelf = isSelf
  }

  public var person: NapPerson { NapPerson(email: email, name: name, shape: shape, color: color) }
  public var firstName: String { person.firstName }
}

/// A channel of a page, like nap.channel(name) on the web: presence and messages between
/// everyone on it, web pages and apps alike. It reconnects by itself until `leave()`.
/// `M` is the messages' type (`site.channel(name, messages: GameMessage.self)`), or JSONValue.
/// SwiftUI views that read `peers` or `isOpen` update with them; the callbacks are for game
/// loops that want each event.
@MainActor
@Observable
public final class NapChannel<M: Codable & Sendable> {
  public let name: String
  /// Everyone on the channel, oldest first, this device included.
  public private(set) var peers: [NapPeer] = []
  public private(set) var isOpen = false
  /// This device's id on the channel, while it is open.
  public private(set) var selfId: String?

  @ObservationIgnored public var onPresence: (([NapPeer]) -> Void)?
  @ObservationIgnored public var onJoin: ((NapPeer) -> Void)?
  @ObservationIgnored public var onLeave: ((NapPeer) -> Void)?
  @ObservationIgnored public var onMessage: ((NapPeer, M) -> Void)?
  @ObservationIgnored public var onStatus: ((Bool) -> Void)?
  @ObservationIgnored public var onError: ((String) -> Void)?

  @ObservationIgnored private let site: NapSite
  @ObservationIgnored private var socket: URLSessionWebSocketTask?
  @ObservationIgnored private var map: [String: NapPeer] = [:]
  @ObservationIgnored private var presence: JSONValue?
  @ObservationIgnored private var retries = 0
  /// Bumped on every connect, so a retry that was waiting does not open a second socket.
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var left = false
  @ObservationIgnored private var pingTask: Task<Void, Never>?

  /// Watching: this device sees the peers but is not one of them (see `NapSite.watch`).
  public let isWatching: Bool

  init(site: NapSite, name: String, watch: Bool = false) {
    self.site = site
    self.name = name
    self.isWatching = watch
    connect()
  }

  /// Other people's connections (not this device's).
  public var others: [NapPeer] { peers.filter { !$0.isSelf } }

  /// Sets this device's presence, which everyone sees in `peers`.
  public func setPresence(_ state: some Encodable & Sendable) {
    guard !isWatching else { return }
    let state = JSONValue.from(state)
    presence = state
    if let selfId { map[selfId]?.state = state; publish() }
    if isOpen { raw(["t": .string("presence"), "state": state]) }
  }

  private struct Outgoing: Encodable { var t = "send"; var data: M; var to: String? }

  /// Sends a message to everyone else, or to one peer by id. False while the channel is closed.
  @discardableResult
  public func send(_ data: M, to: String? = nil) -> Bool {
    guard isOpen, !isWatching, let socket, let text = try? JSONEncoder().encode(Outgoing(data: data, to: to)) else {
      return false
    }
    socket.send(.string(String(decoding: text, as: UTF8.self))) { _ in }
    return true
  }

  /// Drops the connection and connects again now, e.g. after the app was in the background.
  public func refresh() {
    guard !left else { return }
    if let task = socket {
      task.cancel(with: .goingAway, reason: nil)
      closed(task)
    }
    retries = 0
    connect()
  }

  public func leave() {
    left = true
    pingTask?.cancel()
    // A moment for the last messages, such as a goodbye, to go out before the socket closes.
    let task = socket
    Task {
      try? await Task.sleep(for: .milliseconds(300))
      task?.cancel(with: .normalClosure, reason: nil)
    }
    socket = nil
    isOpen = false
  }

  // MARK: The socket (src/lib/site-channel.ts)

  private func connect() {
    guard !left, let token = NapAccount.shared.token else { return }
    attempt += 1
    var url = URLComponents(url: site.url("channel/\(name)"), resolvingAgainstBaseURL: false)!
    if isWatching { url.queryItems = [URLQueryItem(name: "watch", value: "1")] }
    url.scheme = url.scheme == "http" ? "ws" : "wss"
    var request = URLRequest(url: url.url!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let task = URLSession.shared.webSocketTask(with: request)
    socket = task
    task.resume()
    receive(task)
  }

  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      Task { @MainActor in
        guard let self, self.socket === task else { return }
        switch result {
        case .success(let message):
          if case .string(let text) = message { self.handle(text) }
          self.receive(task)
        case .failure:
          self.closed(task)
        }
      }
    }
  }

  private struct Incoming: Decodable {
    var t: String
    var id: String?
    var peers: [NapPeer]?
    var peer: NapPeer?
    var state: JSONValue?
    var from: From?
    var data: M?
    var error: String?
    struct From: Decodable { var id: String; var email: String?; var name: String?; var shape: String?; var color: String? }

    private enum Keys: String, CodingKey { case t, id, peers, peer, state, from, data, error }
    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: Keys.self)
      t = try c.decode(String.self, forKey: .t)
      id = try c.decodeIfPresent(String.self, forKey: .id)
      peers = try c.decodeIfPresent([NapPeer].self, forKey: .peers)
      peer = try c.decodeIfPresent(NapPeer.self, forKey: .peer)
      state = try c.decodeIfPresent(JSONValue.self, forKey: .state)
      from = try? c.decodeIfPresent(From.self, forKey: .from)
      // A message of another shape (another version of the page) is dropped, not fatal.
      data = t == "message" ? try? c.decodeIfPresent(M.self, forKey: .data) : nil
      error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
  }

  private func handle(_ text: String) {
    guard text != "pong", let message = try? JSONDecoder().decode(Incoming.self, from: Data(text.utf8)) else {
      return
    }
    switch message.t {
    case "welcome":
      selfId = message.id
      retries = 0
      map = [:]
      for var peer in message.peers ?? [] {
        peer.isSelf = peer.id == selfId
        map[peer.id] = peer
      }
      startPing()
      if let presence, let selfId {
        map[selfId]?.state = presence
        raw(["t": .string("presence"), "state": presence])
      }
      isOpen = true
      publish()
      onStatus?(true)
      onPresence?(peers)
    case "join":
      guard var peer = message.peer else { return }
      peer.isSelf = peer.id == selfId
      map[peer.id] = peer
      publish()
      onJoin?(peer)
      onPresence?(peers)
    case "leave":
      guard let id = message.id, let peer = map.removeValue(forKey: id) else { return }
      publish()
      onLeave?(peer)
      onPresence?(peers)
    case "presence":
      guard let id = message.id, map[id] != nil else { return }
      map[id]?.state = message.state
      publish()
      onPresence?(peers)
    case "message":
      guard let from = message.from, let data = message.data else { return }
      let peer = map[from.id] ?? NapPeer(
        id: from.id, email: from.email ?? "", name: from.name ?? "", shape: from.shape, color: from.color,
        joinedAt: 0)
      onMessage?(peer, data)
    case "error":
      if let error = message.error { onError?(error) }
    default:
      break
    }
  }

  private func publish() {
    peers = map.values.sorted { $0.joinedAt != $1.joinedAt ? $0.joinedAt < $1.joinedAt : $0.id < $1.id }
  }

  private func startPing() {
    pingTask?.cancel()
    pingTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        self?.socket?.send(.string("ping")) { _ in }
      }
    }
  }

  private func closed(_ task: URLSessionWebSocketTask) {
    guard socket === task else { return }
    pingTask?.cancel()
    socket = nil
    selfId = nil
    let hadPeers = !map.isEmpty
    map = [:]
    publish()
    if isOpen {
      isOpen = false
      onStatus?(false)
    }
    if hadPeers { onPresence?([]) }
    guard !left else { return }
    let delay = min(15, 0.5 * pow(2, Double(retries))) * Double.random(in: 0.5...1)
    retries += 1
    let next = attempt
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, self.attempt == next, self.socket == nil else { return }
      self.connect()
    }
  }

  @discardableResult
  private func raw(_ object: [String: JSONValue]) -> Bool {
    guard let socket, let data = try? JSONEncoder().encode(object) else { return false }
    socket.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    return true
  }
}
