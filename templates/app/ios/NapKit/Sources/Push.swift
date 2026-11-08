import SwiftUI
import UIKit
import UserNotifications

/// Notifications on this phone: Nap's (nap.notify from pages and apps) arrive through APNs once
/// someone is signed in and allows them. The launcher starts it and opens what a tap asks for.
@MainActor
@Observable
public final class NapPush {
  public static let shared = NapPush()

  /// Whether this phone gets notifications: nil until known.
  public private(set) var allowed: Bool?
  /// What the last tapped notification opens: the launcher clears it once it has.
  public var opened: NapOpen?

  @ObservationIgnored private var lastToken: String? = UserDefaults.standard.string(forKey: "nap-push-token")

  /// Asks to allow notifications (once: iOS remembers the answer) and registers for them, on
  /// Naps that send them.
  public func start() async {
    guard NapAccount.shared.signedIn, await Nap.canNotify() else { return }
    let center = UNUserNotificationCenter.current()
    let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    allowed = granted
    if granted { UIApplication.shared.registerForRemoteNotifications() }
  }

  /// A notification to this person's own phones and browsers, to check they arrive. Resolves
  /// with how many devices it went to.
  @discardableResult
  public func test() async throws -> Int {
    struct Sent: Decodable { var devices: Int }
    let sent: Sent = try await Nap.request("POST", Nap.api("push/test"))
    return sent.devices
  }

  func registered(_ deviceToken: Data) async {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    struct Device: Encodable { var token: String; var environment: String; var label: String }
    let label = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Nap"
    do {
      struct Saved: Decodable {}
      let _: Saved = try await Nap.request(
        "POST", Nap.api("push/devices"),
        body: Device(token: token, environment: Self.environment, label: "\(label) on \(UIDevice.current.model)"))
      lastToken = token
      UserDefaults.standard.set(token, forKey: "nap-push-token")
    } catch {
      // Notifications off on this Nap, or offline: the next launch tries again.
    }
  }

  /// Signing out: this phone stops getting the person's notifications.
  func signedOut(token: String) async {
    guard let device = lastToken else { return }
    var request = URLRequest(url: Nap.api("push/devices"))
    request.httpMethod = "DELETE"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    request.httpBody = try? JSONEncoder().encode(["token": device])
    _ = try? await URLSession.shared.data(for: request)
    lastToken = nil
    UserDefaults.standard.removeObject(forKey: "nap-push-token")
  }

  /// APNs has a sandbox for builds from Xcode and production for TestFlight. Builds from Xcode
  /// carry a development profile; TestFlight builds carry none.
  static let environment: String = {
    #if targetEnvironment(simulator)
      return "sandbox"
    #else
      guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
        let data = try? Data(contentsOf: url),
        let text = String(data: data, encoding: .isoLatin1),
        let key = text.range(of: "<key>aps-environment</key>")
      else { return "production" }
      let rest = text[key.upperBound...].prefix(80)
      return rest.contains("development") ? "sandbox" : "production"
    #endif
  }()
}

/// What a tapped notification asks to open. `source` is where it came from: "site:<id>" for a
/// page (the launcher opens the app whose app.json names that site), "app:<folder>" for an app.
public struct NapOpen: Equatable, Sendable {
  public var url: URL?
  public var source: String

  /// The page id for "site:<id>".
  public var site: String? { source.hasPrefix("site:") ? String(source.dropFirst(5)) : nil }
  /// The app's folder for "app:<folder>".
  public var app: String? { source.hasPrefix("app:") ? String(source.dropFirst(4)) : nil }
}

/// The launcher's app delegate: device tokens, notifications while open, and taps.
/// `@UIApplicationDelegateAdaptor(NapAppDelegate.self) var delegate` in the App.
public final class NapAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { await NapPush.shared.registered(deviceToken) }
  }

  public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    // No push capability in this build, or no network: notifications stay off.
  }

  // Show notifications while the launcher is open, too.
  public nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  public nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let info = response.notification.request.content.userInfo
    let url = (info["url"] as? String).flatMap(URL.init(string:))
    let source = info["source"] as? String ?? ""
    await MainActor.run { NapPush.shared.opened = NapOpen(url: url, source: source) }
  }
}
