import AuthenticationServices
import SwiftUI
import UIKit

/// Who is signed in, and the sign-in itself: Nap's device flow. The launcher shows it; apps read
/// `Nap.account.signedIn` and can put a `NapSignInButton` where they need someone signed in.
@MainActor
@Observable
public final class NapAccount {
  public static let shared = NapAccount()

  public private(set) var token: String? = Keychain.read("token")
  public private(set) var email: String? = Keychain.read("email")
  public private(set) var name: String? = Keychain.read("name")
  public private(set) var signingIn = false
  /// The code the approval page shows while signing in, to compare.
  public private(set) var userCode: String?
  /// Why the last sign-in or request failed, for the person.
  public var error: String?
  @ObservationIgnored private var authSession: ASWebAuthenticationSession?
  @ObservationIgnored private var signInTask: Task<Void, Never>?
  @ObservationIgnored private let anchor = AnchorProvider()

  public var signedIn: Bool { token != nil }
  /// The signed-in person's first name, or their email.
  public var displayName: String { name ?? email ?? "" }

  init() {
    // Testing: a token from a launch argument (`-nap-token <token>`).
    if let token = UserDefaults.standard.string(forKey: "nap-token") { adopt(token: token) }
  }

  public func adopt(token: String) {
    self.token = token
    Keychain.write("token", token)
    Task { await loadMe() }
  }

  public func signOut() {
    let token = token
    if let token { Task { await NapPush.shared.signedOut(token: token) } }
    self.token = nil
    email = nil
    name = nil
    for key in ["token", "email", "name"] { Keychain.write(key, nil) }
    Nap.forget()
  }

  /// A request was refused: a lost token signs out; a paused one asks to open Nap in Safari.
  func refused(_ refusal: NapError) {
    if refusal.code == "invalid_token" {
      signOut()
      error = "Signed out. Sign in again."
    } else if refusal.code == "inactive" {
      error = "Open \(Nap.origin.host() ?? "Nap") in Safari once, then try again."
    }
  }

  /// The person's name, for apps that show it.
  public func loadMe() async {
    guard let me = try? await Nap.me() else { return }
    email = me.email
    name = me.name
    Keychain.write("email", me.email)
    Keychain.write("name", me.name)
  }

  /// Starts signing in, or does nothing if a sign-in is under way.
  public func startSignIn() {
    guard !signingIn else { return }
    signInTask = Task { await signIn() }
  }

  public func cancelSignIn() {
    signInTask?.cancel()
  }

  /// The device flow: get a code, show the approval page, and poll for the token.
  public func signIn() async {
    guard !signingIn else { return }
    signingIn = true
    error = nil
    defer {
      signingIn = false
      userCode = nil
      authSession?.cancel()
      authSession = nil
    }
    do {
      struct Start: Decodable {
        var device_code: String
        var user_code: String
        var verification_uri_complete: String
        var interval: Double?
      }
      let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Nap"
      let start: Start = try await Nap.request(
        "POST", Nap.api("auth/device"), body: ["client": "\(app) for iOS"], auth: false)
      userCode = start.user_code
      if let url = URL(string: start.verification_uri_complete) { present(url) }
      struct TokenResponse: Decodable { var token: String?; var email: String?; var error: String? }
      let interval = max(2, start.interval ?? 5)
      let deadline = Date().addingTimeInterval(10 * 60)
      while Date() < deadline {
        try await Task.sleep(for: .seconds(interval))
        let body = try JSONEncoder().encode(["device_code": start.device_code])
        let (data, response) = try await Nap.send("POST", Nap.api("auth/token"), body: body, auth: false)
        let result = try JSONDecoder().decode(TokenResponse.self, from: data)
        if let token = result.token {
          self.token = token
          email = result.email
          Keychain.write("token", token)
          Keychain.write("email", result.email)
          await loadMe()
          return
        }
        switch result.error {
        case "authorization_pending", "slow_down": continue
        case "access_denied":
          error = "Sign-in was denied."
          return
        default:
          error = "Sign-in failed (\(result.error ?? String(response.statusCode)))."
          return
        }
      }
      error = "Sign-in timed out."
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// The approval page, in a browser sheet that shares Safari's cookies, so Access is usually
  /// signed in already. It never calls back: polling notices the approval and closes it.
  private func present(_ url: URL) {
    let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "nap-signin") { _, _ in }
    session.presentationContextProvider = anchor
    session.prefersEphemeralWebBrowserSession = false
    authSession = session
    session.start()
  }
}

private final class AnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      return scenes.flatMap(\.windows).first { $0.isKeyWindow }
        ?? scenes.first.map { UIWindow(windowScene: $0) } ?? UIWindow()
    }
  }
}

/// Sign in to Nap, with the code to compare and a way to cancel while it waits.
public struct NapSignInButton: View {
  private var account = NapAccount.shared
  private let label: String

  public init(_ label: String = "Sign in to \(Nap.origin.host() ?? "Nap")") {
    self.label = label
  }

  public var body: some View {
    VStack(spacing: 8) {
      if account.signingIn {
        HStack(spacing: 10) {
          ProgressView()
          if let code = account.userCode {
            Text("Approve code \(code)").monospacedDigit()
          } else {
            Text("Signing in…")
          }
          Button("Cancel") { account.cancelSignIn() }
        }
      } else {
        Button(label) { account.startSignIn() }
          .buttonStyle(.borderedProminent)
      }
      if let error = account.error {
        Text(error).font(.footnote).foregroundStyle(.secondary)
      }
    }
  }
}
