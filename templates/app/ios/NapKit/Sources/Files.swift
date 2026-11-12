import Foundation

/// A file of a page (nap.files), from `site.files.upload`: its id, type, size in bytes, name,
/// who uploaded it (email), and when (ISO 8601).
public struct NapFile: Codable, Sendable, Hashable, Identifiable {
  public var id: String
  public var type: String
  public var size: Int
  public var name: String?
  public var createdBy: String
  public var createdAt: String
}

/// The page's files, like nap.files on the web: photos and other blobs up to 15 MB, which everyone
/// who can see the page can read and delete. A file never changes; upload a new one instead.
/// Keep the id in a document to find the file again.
@MainActor
public struct NapFiles {
  let site: NapSite

  /// Stores `data` as a new file of the page. `type` is its content type, such as "image/jpeg".
  public func upload(_ data: Data, type: String, name: String? = nil) async throws -> NapFile {
    var headers: [String: String] = [:]
    if let name, !name.isEmpty {
      headers["x-nap-file-name"] = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    }
    let (answer, response) = try await Nap.send(
      "POST", site.url("blobs"), body: data, contentType: type, headers: headers)
    try Nap.check(answer, response)
    struct Uploaded: Decodable { var file: NapFile }
    return try JSONDecoder().decode(Uploaded.self, from: answer).file
  }

  /// The file's bytes, downloaded with the sign-in. Files never change, so keep them if you show
  /// them often.
  public func data(_ id: String) async throws -> Data {
    let (answer, response) = try await Nap.send("GET", url(id))
    try Nap.check(answer, response)
    return answer
  }

  /// Deletes the file. Documents that name it keep its id: remove that too.
  public func delete(_ id: String) async throws {
    let (answer, response) = try await Nap.send("DELETE", url(id))
    try Nap.check(answer, response)
  }

  /// /_nap/api/naps/<id>/blobs/<file>. It needs the Nap token: use `data(_:)` to show one.
  public func url(_ id: String) -> URL {
    site.url("blobs/" + (id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id))
  }
}
