import SwiftUI

/// The launcher: every prototype in Prototypes/, newest first in the order of the registry.
/// Prototypes open full screen. Tap the close button in the top corner to come back.
@main
struct LauncherApp: App {
  var body: some Scene {
    WindowGroup { LauncherView() }
  }
}

struct PrototypeEntry: Identifiable {
  let slug: String
  let title: String
  let summary: String
  let view: @MainActor () -> AnyView
  var id: String { slug }
}

struct LauncherView: View {
  @State private var open: PrototypeEntry?

  var body: some View {
    NavigationStack {
      List(Registry.prototypes) { prototype in
        Button {
          open = prototype
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(prototype.title).font(.headline)
            if !prototype.summary.isEmpty {
              Text(prototype.summary).font(.subheadline).foregroundStyle(.secondary)
            }
          }
        }
        .foregroundStyle(.primary)
      }
      .navigationTitle("Nap")
      .safeAreaInset(edge: .bottom) {
        Text("Build \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?")")
          .font(.footnote)
          .foregroundStyle(.tertiary)
          .padding(.bottom, 8)
      }
    }
    .fullScreenCover(item: $open) { prototype in
      prototype.view()
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
          .accessibilityLabel("Close prototype")
        }
    }
  }
}
