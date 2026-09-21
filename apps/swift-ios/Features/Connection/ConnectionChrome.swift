import SwiftUI

// Pieces shared by the launch, onboarding, T3 Connect and setup screens.

/// The app mark: "T3" on an ink tile. It inverts with the palette, so it reads
/// on the launch screen, Welcome and sign-in in light and dark alike.
struct T3BrandMark: View {
    @ScaledMetric private var size: CGFloat

    init(size: CGFloat = 64) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: .largeTitle)
    }

    var body: some View {
        Text("T3")
            .font(.system(size: size * 0.4, weight: .black, design: .rounded))
            .foregroundStyle(T3Colors.primaryActionForeground)
            .frame(width: size, height: size)
            .background(T3Colors.primaryAction, in: RoundedRectangle(cornerRadius: size * 0.25, style: .continuous))
            .accessibilityLabel("T3 Code")
    }
}

extension View {
    /// Pins `content` to the bottom edge: the scroll-edge glass bar on iOS 26,
    /// a bar material before that.
    @ViewBuilder
    func t3BottomBar<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom) {
                content()
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
            }
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) {
                content()
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity)
                    .background(.bar)
            }
        }
    }
}

/// A trailing "Paste" control for pairing-link rows. `PasteButton` reads the
/// clipboard only when tapped, so iOS never shows the "Allow Paste" prompt,
/// and it disables itself when the clipboard holds no text.
struct ConnectionPasteButton: View {
    let onPaste: (String) -> Void

    var body: some View {
        PasteButton(payloadType: String.self) { strings in
            guard let value = strings.first(where: { !$0.isEmpty }) else { return }
            Task { @MainActor in onPaste(value) }
        }
        .labelStyle(.titleAndIcon)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(T3Colors.accent)
    }
}

/// An error that owns its own inset-grouped section: a danger glyph, a title
/// and the explanation, plus optional action rows below it.
struct ConnectionProblemRow: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                Text(message)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: systemImage)
                .foregroundStyle(T3Colors.danger)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
