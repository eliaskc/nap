import SwiftUI

/// The launcher: every app in Apps/, in the order of the registry.
/// Apps open full screen. Tap the close button in the top corner to come back.
@main
struct LauncherApp: App {
  var body: some Scene {
    WindowGroup { LauncherView() }
  }
}

struct AppEntry: Identifiable {
  let slug: String
  let title: String
  let summary: String
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

  var body: some View {
    NavigationStack {
      List(Registry.apps) { app in
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
  }
}
