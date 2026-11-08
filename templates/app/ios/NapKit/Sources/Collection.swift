import Foundation

/// A document as Nap stores it. `data` is the JSON the page saved; `decode` reads it as a type.
public struct NapDocument: Codable, Identifiable, Sendable {
  public var id: String
  public var data: JSONValue?
  public var version: Int
  public var deleted: Bool?
  public var createdBy: String?
  public var updatedBy: String?
  public var createdAt: String?
  public var updatedAt: String?

  public func decode<T: Decodable>(_: T.Type = T.self) -> T? { data?.decode(T.self) }
}

/// One collection of a page, like nap.db.collection(name) on the web. `watch()` keeps
/// `documents` current with the live socket (polling as a safety net); SwiftUI views that read
/// it update with it. Writes apply at once.
@MainActor
@Observable
public final class NapCollection {
  @ObservationIgnored public unowned let site: NapSite
  public let name: String
  /// Every document, newest first. Empty until the first load: see `loaded`.
  public private(set) var documents: [NapDocument] = []
  public private(set) var loaded = false
  private var byId: [String: NapDocument] = [:]
  @ObservationIgnored private var since = 0
  @ObservationIgnored private(set) var watched = false

  init(site: NapSite, name: String) {
    self.site = site
    self.name = name
  }

  public func document(_ id: String) -> NapDocument? {
    byId[id].flatMap { $0.deleted == true ? nil : $0 }
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

  /// Takes a change from the socket, a poll, or a write, unless a newer one is already here.
  func apply(_ change: NapDocument) {
    let known = byId[change.id]?.version ?? 0
    guard change.version > known else { return }
    // A delete stays as a tombstone, so a slow poll cannot bring the document back.
    byId[change.id] = change.deleted == true
      ? NapDocument(id: change.id, data: nil, version: change.version, deleted: true) : change
    publish()
  }

  private func publish() {
    documents = byId.values.filter { $0.deleted != true }.sorted {
      ($0.createdAt ?? "", $0.id) > ($1.createdAt ?? "", $1.id)
    }
  }

  /// Catches up with the changes feed.
  func poll() async {
    struct Page: Decodable { var changes: [NapDocument]; var since: Int; var hasMore: Bool }
    do {
      var more = true
      while more {
        var url = URLComponents(url: site.url("data/\(name)"), resolvingAgainstBaseURL: false)!
        url.queryItems = [.init(name: "since", value: String(since)), .init(name: "limit", value: "100")]
        let page: Page = try await Nap.request("GET", url.url!)
        for change in page.changes { apply(change) }
        since = page.since
        more = page.hasMore
      }
      if !loaded { loaded = true }
    } catch {}
  }

  // MARK: Reads and writes

  private struct Saved: Decodable { var document: NapDocument }

  private func item(_ id: String) -> URL {
    site.url("data/\(name)/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
  }

  private func preconditions(ifVersion: Int?, ifNew: Bool) -> [String: String] {
    var headers: [String: String] = [:]
    if let ifVersion { headers["if-match"] = "\"\(ifVersion)\"" }
    if ifNew { headers["if-none-match"] = "*" }
    return headers
  }

  public func get(_ id: String) async throws -> NapDocument {
    let saved: Saved = try await Nap.request("GET", item(id))
    apply(saved.document)
    return saved.document
  }

  /// A new document with an id Nap picks.
  @discardableResult
  public func create(_ data: some Encodable & Sendable) async throws -> NapDocument {
    let saved: Saved = try await Nap.request("POST", site.url("data/\(name)"), body: data)
    apply(saved.document)
    return saved.document
  }

  /// Creates or replaces the document with this id. `ifNew` only creates; `ifVersion` fails
  /// with a 409 NapError if someone saved in between.
  @discardableResult
  public func put(_ id: String, _ data: some Encodable & Sendable, ifVersion: Int? = nil, ifNew: Bool = false)
    async throws -> NapDocument
  {
    let saved: Saved = try await Nap.request(
      "PUT", item(id), body: data, headers: preconditions(ifVersion: ifVersion, ifNew: ifNew))
    apply(saved.document)
    return saved.document
  }

  /// Merges fields into a document (JSON Merge Patch: `.null` removes a field).
  @discardableResult
  public func patch(_ id: String, _ data: some Encodable & Sendable, ifVersion: Int? = nil) async throws -> NapDocument {
    let saved: Saved = try await Nap.request(
      "PATCH", item(id), body: data, headers: preconditions(ifVersion: ifVersion, ifNew: false))
    apply(saved.document)
    return saved.document
  }

  public func delete(_ id: String, ifVersion: Int? = nil) async throws {
    let (data, response) = try await Nap.send(
      "DELETE", item(id), headers: preconditions(ifVersion: ifVersion, ifNew: false))
    try Nap.check(data, response)
    if let known = byId[id] { apply(NapDocument(id: id, version: known.version + 1, deleted: true)) }
  }

  /// Creates a document once; someone else creating it first is fine.
  public func ensure(_ id: String, _ data: some Encodable & Sendable) async {
    _ = try? await put(id, data, ifNew: true)
  }

  /// Applies `change` to the newest version of a document and saves it, again when someone else
  /// saved first. Return nil to leave it. Like `mutate` in web pages.
  public func mutate<T: Codable & Sendable>(_ id: String, as _: T.Type, _ change: (T?) -> T?) async throws {
    var current = document(id)
    for _ in 0..<6 {
      guard let next = change(current?.decode(T.self)) else { return }
      do {
        if let current {
          try await put(id, next, ifVersion: current.version)
        } else {
          try await put(id, next, ifNew: true)
        }
        return
      } catch let error as NapError where error.status == 409 || error.status == 412 {
        if let latest = error.document {
          apply(latest)
          current = latest.deleted == true ? nil : latest
        } else {
          current = try? await get(id)
        }
      }
    }
    throw NapError(message: "Too many people changed this at once. Try again.", status: 409)
  }
}
