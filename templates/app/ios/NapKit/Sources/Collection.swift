import Foundation

/// A document as Nap stores it, with its data as the collection's type.
public struct NapDocument<T: Codable & Sendable>: Codable, Sendable, Identifiable {
  public let id: String
  public var data: T
  public var version: Int
  public var createdBy: String
  public var updatedBy: String
  public var createdAt: String
  public var updatedAt: String

  public init(
    id: String, data: T, version: Int = 0, createdBy: String = "", updatedBy: String = "",
    createdAt: String = "", updatedAt: String = ""
  ) {
    self.id = id
    self.data = data
    self.version = version
    self.createdBy = createdBy
    self.updatedBy = updatedBy
    self.createdAt = createdAt
    self.updatedAt = updatedAt
  }

  /// The same document with its data as another type, if it decodes.
  public func `as`<U: Codable & Sendable>(_: U.Type) -> NapDocument<U>? {
    guard let data = JSONValue.from(data).decode(U.self) else { return nil }
    return NapDocument<U>(
      id: id, data: data, version: version, createdBy: createdBy, updatedBy: updatedBy,
      createdAt: createdAt, updatedAt: updatedAt)
  }
}

/// A write from the changes feed or the live socket: a document, or a delete. A document whose
/// data does not decode as the collection's type is skipped.
struct NapChange<T: Codable & Sendable>: Decodable, Sendable {
  var id: String
  var version: Int
  var deleted: Bool
  var document: NapDocument<T>?

  private enum Keys: String, CodingKey { case id, version, deleted }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(String.self, forKey: .id)
    version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 0
    deleted = try c.decodeIfPresent(Bool.self, forKey: .deleted) ?? false
    document = deleted ? nil : try? NapDocument<T>(from: decoder)
  }
}

/// What every collection of a site does for it, whatever its type.
@MainActor
protocol NapCollectionBase: AnyObject {
  var name: String { get }
  var watched: Bool { get }
  func poll() async
  func receive(_ message: Data)
  func forget()
}

/// One collection of a page, like nap.db.collection<T>(name) on the web:
/// `Nap.site("elo").db.collection("games", of: Game.self)`. `watch()` keeps `documents` current
/// with the live socket (polling as a safety net); SwiftUI views that read it update with it, and
/// `onChange` calls back after each batch of changes. Writes apply at once.
@MainActor
@Observable
public final class NapCollection<T: Codable & Sendable>: NapCollectionBase {
  @ObservationIgnored public unowned let site: NapSite
  public let name: String
  /// Every document, newest first. Empty until the first load: see `loaded`.
  public private(set) var documents: [NapDocument<T>] = []
  /// Whether the documents are known: loaded from Nap, or from the copy on the device.
  public private(set) var loaded = false
  /// Why the last load failed, while it has not succeeded since.
  public private(set) var error: NapError?

  private var byId: [String: NapDocument<T>] = [:]
  /// The version of each deleted document, so an older change cannot bring it back.
  @ObservationIgnored private var deletedAt: [String: Int] = [:]
  @ObservationIgnored private var since = 0
  @ObservationIgnored private(set) var watched = false
  @ObservationIgnored private var listeners: [@MainActor () -> Void] = []
  @ObservationIgnored private var keepsCopy = false
  @ObservationIgnored private var saveTask: Task<Void, Never>?

  init(site: NapSite, name: String) {
    self.site = site
    self.name = name
  }

  public func document(_ id: String) -> NapDocument<T>? { byId[id] }

  /// Calls back after each batch of changes, for state derived from the documents.
  public func onChange(_ listener: @escaping @MainActor () -> Void) {
    listeners.append(listener)
  }

  /// Loads the collection and keeps it current. Needs someone signed in.
  public func watch() {
    guard NapAccount.shared.signedIn else { return }
    if !watched {
      watched = true
      Task { await poll() }
    }
    site.watching()
  }

  /// Stops keeping it current, e.g. when the app closes. The documents stay.
  public func unwatch() {
    watched = false
    site.unwatched()
  }

  // MARK: Changes

  /// Takes changes from the socket, a poll, or a write, unless newer ones are here already.
  @discardableResult
  private func apply(_ changes: [NapChange<T>]) -> Bool {
    var changed = false
    for change in changes {
      let known = byId[change.id]?.version ?? deletedAt[change.id] ?? 0
      guard change.version > known else { continue }
      if change.deleted {
        deletedAt[change.id] = change.version
        if byId.removeValue(forKey: change.id) != nil { changed = true }
      } else if let document = change.document {
        byId[document.id] = document
        deletedAt[document.id] = nil
        changed = true
      }
    }
    return changed
  }

  private func applied(_ document: NapDocument<T>) {
    let known = byId[document.id]?.version ?? deletedAt[document.id] ?? 0
    guard document.version > known else { return }
    byId[document.id] = document
    deletedAt[document.id] = nil
    publish()
  }

  private func removed(_ id: String) {
    guard let document = byId.removeValue(forKey: id) else { return }
    deletedAt[id] = document.version + 1
    publish()
  }

  private func publish() {
    documents = byId.values.sorted { ($0.createdAt, $0.id) > ($1.createdAt, $1.id) }
    if !loaded { loaded = true }
    for listener in listeners { listener() }
    saveSoon()
  }

  private struct Page: Decodable { var changes: [NapChange<T>]; var since: Int; var hasMore: Bool }

  /// Catches up with the changes feed, applying it in one go.
  func poll() async {
    do {
      var changes: [NapChange<T>] = []
      var next = since
      var more = true
      while more {
        var url = URLComponents(url: site.url("data/\(name)"), resolvingAgainstBaseURL: false)!
        url.queryItems = [.init(name: "since", value: String(next)), .init(name: "limit", value: "500")]
        let page: Page = try await Nap.request("GET", url.url!)
        changes += page.changes
        next = page.since
        more = page.hasMore
      }
      since = max(since, next)
      error = nil
      if apply(changes) || !loaded { publish() }
    } catch let failure as NapError {
      error = failure
    } catch {
      self.error = NapError(message: error.localizedDescription, status: 0)
    }
  }

  private struct LiveChange: Decodable { var change: NapChange<T> }

  /// A change from the site's live socket.
  func receive(_ message: Data) {
    guard let live = try? JSONDecoder().decode(LiveChange.self, from: message) else { return }
    if apply([live.change]) { publish() }
  }

  /// Signed out: nothing of the person's stays, in memory or on the device.
  func forget() {
    watched = false
    byId = [:]
    deletedAt = [:]
    since = 0
    documents = []
    loaded = false
    error = nil
    saveTask?.cancel()
  }

  // MARK: The copy on the device

  private struct Copy: Codable { var since: Int; var documents: [NapDocument<T>]; var deleted: [String: Int] }

  private var copyURL: URL {
    NapSite.copies.appending(path: "\(site.id)-\(name).json")
  }

  /// Keeps a copy on the device, so the next launch shows the documents at once and only
  /// fetches what changed since. Signing out deletes it.
  func keepCopy() {
    guard !keepsCopy else { return }
    keepsCopy = true
    guard !loaded, NapAccount.shared.signedIn, let data = try? Data(contentsOf: copyURL),
      let copy = try? JSONDecoder().decode(Copy.self, from: data)
    else { return }
    since = copy.since
    deletedAt = copy.deleted
    byId = Dictionary(copy.documents.map { ($0.id, $0) }) { a, _ in a }
    publish()
  }

  private func saveSoon() {
    guard keepsCopy, NapAccount.shared.signedIn else { return }
    saveTask?.cancel()
    let copy = Copy(since: since, documents: Array(byId.values), deleted: deletedAt)
    let url = copyURL
    saveTask = Task.detached(priority: .utility) {
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled, let data = try? JSONEncoder().encode(copy) else { return }
      try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? data.write(to: url, options: .atomic)
    }
  }

  // MARK: Reads and writes

  private struct Saved: Decodable { var document: NapDocument<T> }

  private func item(_ id: String) -> URL {
    site.url("data/\(name)/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
  }

  private func preconditions(ifVersion: Int?, ifNew: Bool) -> [String: String] {
    var headers: [String: String] = [:]
    if let ifVersion { headers["if-match"] = "\"\(ifVersion)\"" }
    if ifNew { headers["if-none-match"] = "*" }
    return headers
  }

  public func get(_ id: String) async throws -> NapDocument<T> {
    let saved: Saved = try await Nap.request("GET", item(id))
    applied(saved.document)
    return saved.document
  }

  /// A new document with an id Nap picks.
  @discardableResult
  public func create(_ data: T) async throws -> NapDocument<T> {
    let saved: Saved = try await Nap.request("POST", site.url("data/\(name)"), body: data)
    applied(saved.document)
    return saved.document
  }

  /// Creates or replaces the document with this id. `ifNew` only creates (412 if it exists);
  /// `ifVersion` fails with a 409 NapError if someone saved in between.
  @discardableResult
  public func put(_ id: String, _ data: T, ifVersion: Int? = nil, ifNew: Bool = false) async throws
    -> NapDocument<T>
  {
    let saved: Saved = try await Nap.request(
      "PUT", item(id), body: data, headers: preconditions(ifVersion: ifVersion, ifNew: ifNew))
    applied(saved.document)
    return saved.document
  }

  /// Merges fields into a document (JSON Merge Patch: `JSONValue.null` removes a field).
  @discardableResult
  public func patch(_ id: String, _ fields: some Encodable & Sendable, ifVersion: Int? = nil) async throws
    -> NapDocument<T>
  {
    let saved: Saved = try await Nap.request(
      "PATCH", item(id), body: fields, headers: preconditions(ifVersion: ifVersion, ifNew: false))
    applied(saved.document)
    return saved.document
  }

  public func delete(_ id: String, ifVersion: Int? = nil) async throws {
    let (data, response) = try await Nap.send(
      "DELETE", item(id), headers: preconditions(ifVersion: ifVersion, ifNew: false))
    try Nap.check(data, response)
    removed(id)
  }

  /// Creates a document once; someone else creating it first is fine.
  public func ensure(_ id: String, _ data: T) async {
    _ = try? await put(id, data, ifNew: true)
  }

  /// Applies `change` to the newest version of a document and saves it, again when someone else
  /// saved first. Return nil to leave it. Like `mutate` in web pages.
  public func mutate(_ id: String, _ change: (T?) -> T?) async throws {
    var current = document(id)
    for _ in 0..<6 {
      guard let next = change(current?.data) else { return }
      do {
        if let current {
          try await put(id, next, ifVersion: current.version)
        } else {
          try await put(id, next, ifNew: true)
        }
        return
      } catch let error as NapError where error.status == 409 || error.status == 412 {
        if let latest = error.document?.as(T.self) {
          applied(latest)
          current = latest
        } else {
          current = try? await get(id)
        }
      }
    }
    throw NapError(message: "Too many people changed this at once. Try again.", status: 409)
  }
}
