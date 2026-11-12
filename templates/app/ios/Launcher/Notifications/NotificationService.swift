import Foundation
import UserNotifications

/// The launcher's notification service extension: a notification with a picture (nap.notify's
/// `image`) arrives with `mutable-content` and the picture's URL, and this downloads it and
/// attaches it, so it shows as the thumbnail and when expanded. Without a picture, or when the
/// download fails or takes too long, the notification shows as it came. Part of the template:
/// Nap signs it with its own profile.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
  private let lock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?
  private var task: URLSessionDownloadTask?

  override func didReceive(
    _ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    lock.withLock {
      self.contentHandler = contentHandler
      self.content = content
    }
    guard let text = request.content.userInfo["image"] as? String, let url = URL(string: text),
      url.scheme == "https"
    else { return deliver(nil) }
    let task = URLSession.shared.downloadTask(with: url) { [self] location, response, _ in
      var attachment: UNNotificationAttachment?
      if let location, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
        // The file is gone once this returns, and attachments need a name iOS knows the type of.
        let file = FileManager.default.temporaryDirectory
          .appending(path: UUID().uuidString + "." + Self.fileExtension(http.mimeType))
        if (try? FileManager.default.moveItem(at: location, to: file)) != nil {
          attachment = try? UNNotificationAttachment(identifier: "image", url: file)
        }
      }
      deliver(attachment)
    }
    lock.withLock { self.task = task }
    task.resume()
  }

  override func serviceExtensionTimeWillExpire() {
    lock.withLock { task }?.cancel()
    deliver(nil)
  }

  /// Hands the notification to iOS, once.
  private func deliver(_ attachment: UNNotificationAttachment?) {
    let (handler, content) = lock.withLock {
      let taken = (contentHandler, self.content)
      contentHandler = nil
      return taken
    }
    guard let handler, let content else { return }
    if let attachment { content.attachments = [attachment] }
    handler(content)
  }

  private static func fileExtension(_ type: String?) -> String {
    switch type?.lowercased() {
    case "image/png": "png"
    case "image/gif": "gif"
    case "image/heic": "heic"
    case "image/webp": "webp"
    default: "jpg"
    }
  }
}
