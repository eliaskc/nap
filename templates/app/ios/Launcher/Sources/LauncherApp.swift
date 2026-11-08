import NapKit
import SwiftUI

/// The launcher: every app in Apps/, in the order of the registry.
/// Apps open full screen. Tap the close button in the top corner to come back.
/// It also signs in to Nap once for every app (NapKit), and gets Nap's notifications.
@main
struct LauncherApp: App {
  @UIApplicationDelegateAdaptor(NapAppDelegate.self) private var delegate

  var body: some Scene {
    WindowGroup { LauncherView() }
  }
}

struct AppEntry: Identifiable {
  let slug: String
  let title: String
  let summary: String
  /// The page on Nap the app plays with: its notifications open the app.
  let site: String
  let view: @MainActor () -> AnyView
  var id: String { slug }
}

/// Capabilities an app asked for in app.json and this build does not have, by app. Nap writes
/// them into Info.plist when it signs.
enum CapabilityWarnings {
  static let all = Bundle.main.object(forInfoDictionaryKey: "NapCapabilityWarnings")
    as? [String: [String]] ?? [:]
  static func of(_ slug: String) -> [String] { all[slug] ?? [] }
}

struct CapabilityWarningList: View {
  let warnings: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      ForEach(warnings, id: \.self) { warning in
        Label(warning, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
  }
}

struct LauncherView: View {
  @State private var open: AppEntry?
  @State private var testResult: String?
  @Environment(\.openURL) private var openURL
  private var account = Nap.account
  private var push = NapPush.shared

  var body: some View {
    NavigationStack {
      List {
        if !account.signedIn {
          Section {
            VStack(alignment: .leading, spacing: 10) {
              Text("Sign in to \(Nap.origin.host() ?? "Nap") so the apps can play together and you get notifications.")
                .font(.subheadline)
              NapSignInButton()
            }
            .padding(.vertical, 4)
          }
        }
        Section {
          ForEach(Registry.apps) { app in
            row(app)
          }
        }
      }
      .toolbar {
        if account.signedIn {
          Menu {
            Text(account.displayName)
            Button("Send a test notification", systemImage: "bell") { sendTest() }
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
              account.signOut()
            }
          } label: {
            Image(systemName: "person.crop.circle")
          }
          .accessibilityLabel("Account")
        }
      }
      .alert(testResult ?? "", isPresented: Binding(get: { testResult != nil }, set: { if !$0 { testResult = nil } })) {}
      .navigationTitle(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Nap")
      .safeAreaInset(edge: .bottom) {
        Text("Build \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")")
          .font(.footnote)
          .foregroundStyle(.tertiary)
          .padding(.bottom, 8)
      }
    }
    .fullScreenCover(item: $open) { app in
      app.view()
        .safeAreaInset(edge: .bottom) {
          let warnings = CapabilityWarnings.of(app.slug)
          if !warnings.isEmpty {
            CapabilityWarningList(warnings: warnings)
              .padding(10)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
              .padding(.horizontal)
          }
        }
        .overlay(alignment: .topTrailing) {
          Button {
            open = nil
          } label: {
            Image(systemName: "xmark.circle.fill")
              .font(.title2)
              .symbolRenderingMode(.hierarchical)
              .foregroundStyle(.secondary)
              .padding()
          }
          .accessibilityLabel("Close app")
        }
    }
    // Testing: `-open <slug>` opens an app at launch.
    .onAppear {
      if open == nil, let slug = UserDefaults.standard.string(forKey: "open") {
        open = Registry.apps.first { $0.slug == slug }
      }
    }
    // Once someone is signed in, ask to allow notifications and register this phone.
    .task(id: account.signedIn) {
      if account.signedIn { await push.start() }
    }
    // A tapped notification: the app it belongs to, or else its page in the browser.
    .onChange(of: push.opened, initial: true) { _, opened in
      guard let opened else { return }
      push.opened = nil
      if let app = Registry.apps.first(where: {
        $0.slug == opened.app || (!$0.site.isEmpty && $0.site == opened.site)
      }) {
        open = app
      } else if let url = opened.url {
        openURL(url)
      }
    }
  }

  private func row(_ app: AppEntry) -> some View {
    Button {
      open = app
    } label: {
      VStack(alignment: .leading, spacing: 4) {
        Text(app.title).font(.headline)
        if !app.summary.isEmpty {
          Text(app.summary).font(.subheadline).foregroundStyle(.secondary)
        }
        let warnings = CapabilityWarnings.of(app.slug)
        if !warnings.isEmpty {
          CapabilityWarningList(warnings: warnings)
        }
      }
    }
    .foregroundStyle(.primary)
  }

  private func sendTest() {
    Task {
      do {
        let devices = try await push.test()
        testResult = devices == 0
          ? "Nothing to send to yet. Allow notifications for this app, or turn them on with the bell on \(Nap.origin.host() ?? "Nap")."
          : "Sent to \(devices) \(devices == 1 ? "device" : "devices")."
      } catch {
        testResult = error.localizedDescription
      }
    }
  }
}
