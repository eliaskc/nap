import SwiftUI

/// Every prototype exposes a public PrototypeView. The launcher shows it full screen.
public struct PrototypeView: View {
  @State private var taps = 0

  public init() {}

  public var body: some View {
    VStack(spacing: 16) {
      Text("Hello from Nap").font(.largeTitle.bold())
      Button("Tapped \(taps) times") { taps += 1 }
        .buttonStyle(.borderedProminent)
    }
  }
}
