import SwiftUI
import UIKit

// Shared system chrome: sheet toolbars, buttons, grouped lists, feedback.
// Each piece uses the iOS 26 control where one exists and keeps the closest
// earlier equivalent as the fallback, because the app still deploys to iOS 17.

// MARK: - Sheet toolbar

/// How a sheet's leading button leaves.
enum T3SheetDismissal {
    /// Read-only sheets: nothing is lost by leaving.
    case close
    /// Edit sheets: leaving throws the edits away.
    case cancel
}

/// The commit action of an edit sheet, shown as the trailing toolbar button.
struct T3SheetConfirmation {
    /// Shown as text before iOS 26 and read by VoiceOver on every version.
    var title: String
    var isEnabled = true
    var isBusy = false
    var action: () -> Void
}

extension View {
    /// Puts a sheet's leave and commit buttons in the navigation bar.
    ///
    /// iOS 26 draws them as the system close / cancel xmark and the prominent
    /// confirm checkmark. Earlier systems get the familiar text buttons: "Done"
    /// trailing for read-only sheets, "Cancel" leading and the commit title
    /// trailing for edit sheets. Apply it inside the sheet's `NavigationStack`.
    ///
    /// With `hasChanges`, swiping the sheet away is disabled and Cancel asks
    /// before discarding. `onDismiss` replaces the default `dismiss()` when the
    /// presenter owns the sheet's lifetime.
    func t3SheetToolbar(
        _ dismissal: T3SheetDismissal = .close,
        confirm: T3SheetConfirmation? = nil,
        hasChanges: Bool = false,
        onDismiss: (() -> Void)? = nil
    ) -> some View {
        modifier(T3SheetToolbarModifier(
            dismissal: dismissal,
            confirmation: confirm,
            hasChanges: hasChanges,
            onDismiss: onDismiss
        ))
    }
}

private struct T3SheetToolbarModifier: ViewModifier {
    let dismissal: T3SheetDismissal
    let confirmation: T3SheetConfirmation?
    let hasChanges: Bool
    let onDismiss: (() -> Void)?

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var isConfirmingDiscard = false

    func body(content: Content) -> some View {
        content
            .toolbar {
                if dismissal == .close, confirmation == nil {
                    closeItem
                } else {
                    ToolbarItem(placement: .cancellationAction) { cancelButton }
                }
                if let confirmation {
                    ToolbarItem(placement: .confirmationAction) {
                        T3SheetConfirmButton(confirmation: confirmation)
                    }
                }
            }
            .interactiveDismissDisabled(hasChanges)
            .confirmationDialog(
                "Discard your changes?",
                isPresented: $isConfirmingDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard Changes", role: .destructive, action: leave)
                Button("Keep Editing", role: .cancel) {}
            }
    }

    @ToolbarContentBuilder
    private var closeItem: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .cancellationAction) {
                Button(role: .close, action: leave)
            }
        } else {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done", action: leave)
            }
        }
    }

    @ViewBuilder
    private var cancelButton: some View {
        if #available(iOS 26, *) {
            Button(role: .cancel, action: requestCancel)
        } else {
            Button("Cancel", role: .cancel, action: requestCancel)
        }
    }

    private func requestCancel() {
        if hasChanges {
            isConfirmingDiscard = true
        } else {
            leave()
        }
    }

    private func leave() {
        if let onDismiss { onDismiss() } else { dismiss() }
    }
}

/// The trailing commit button. Swaps to a spinner while the commit is in
/// flight so the toolbar never changes shape under the finger.
struct T3SheetConfirmButton: View {
    let confirmation: T3SheetConfirmation

    var body: some View {
        if confirmation.isBusy {
            ProgressView()
                .accessibilityLabel("\(confirmation.title), in progress")
        } else if #available(iOS 26, *) {
            Button(role: .confirm, action: confirmation.action) {
                Label(confirmation.title, systemImage: "checkmark")
            }
            .tint(T3Colors.primaryAction)
            .foregroundStyle(T3Colors.primaryActionForeground)
            .disabled(!confirmation.isEnabled)
        } else {
            Button(action: confirmation.action) {
                Text(confirmation.title).fontWeight(.semibold)
            }
            .disabled(!confirmation.isEnabled)
        }
    }
}

// MARK: - Buttons

extension View {
    /// The one primary call to action on a screen: ink glass on iOS 26, an ink
    /// capsule before that. Use `.controlSize(.large)` for a full-width CTA.
    @ViewBuilder
    func t3ProminentButtonStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glassProminent)
                .tint(T3Colors.primaryAction)
                .foregroundStyle(T3Colors.primaryActionForeground)
        } else {
            buttonStyle(T3ProminentFallbackButtonStyle())
        }
    }

    /// A secondary action beside or below the primary one.
    @ViewBuilder
    func t3SecondaryButtonStyle() -> some View {
        if #available(iOS 26, *) {
            buttonStyle(.glass)
                .foregroundStyle(T3Colors.textPrimary)
        } else {
            buttonStyle(.bordered)
                .tint(T3Colors.textPrimary)
        }
    }
}

/// `.borderedProminent` paints its label white, which disappears on the
/// near-white ink of dark palettes; this keeps the palette's own foreground.
private struct T3ProminentFallbackButtonStyle: ButtonStyle {
    @SwiftUI.Environment(\.controlSize) private var controlSize
    @SwiftUI.Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(T3Typography.control.weight(.semibold))
            .foregroundStyle(T3Colors.primaryActionForeground)
            .padding(.horizontal, controlSize == .large ? 20 : 14)
            .padding(.vertical, controlSize == .large ? 14 : 8)
            .background(T3Colors.primaryAction, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .contentShape(Capsule())
    }
}

// MARK: - Grouped lists

extension View {
    /// Inset-grouped `List` or `Form` drawn on the palette background instead of
    /// the system grouped gray, so a selected theme still repaints it.
    func t3GroupedListBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(T3Colors.background)
    }

    /// Row fill for inset-grouped lists that use `t3GroupedListBackground()`.
    func t3GroupedRow() -> some View {
        listRowBackground(T3Colors.surface)
    }
}

/// Settings-style colored tile behind a row's symbol. Content lists use plain
/// glyphs instead; tiles are for navigation and settings rows.
struct T3SettingsTile: View {
    enum Tint {
        case blue, green, orange, red, gray, indigo, purple, teal, pink, yellow, ink

        var fill: Color {
            switch self {
            case .blue: Color(red: 0, green: 0.478, blue: 1)
            case .green: Color(red: 0.204, green: 0.78, blue: 0.349)
            case .orange: Color(red: 1, green: 0.584, blue: 0)
            case .red: Color(red: 1, green: 0.231, blue: 0.188)
            case .gray: Color(red: 0.557, green: 0.557, blue: 0.576)
            case .indigo: Color(red: 0.345, green: 0.337, blue: 0.839)
            case .purple: Color(red: 0.686, green: 0.322, blue: 0.871)
            case .teal: Color(red: 0.188, green: 0.69, blue: 0.78)
            case .pink: Color(red: 1, green: 0.176, blue: 0.333)
            case .yellow: Color(red: 1, green: 0.8, blue: 0)
            case .ink: T3Colors.primaryAction
            }
        }

        var glyph: Color {
            self == .ink ? T3Colors.primaryActionForeground : .white
        }
    }

    let systemName: String
    let tint: Tint

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 29

    init(_ systemName: String, tint: Tint) {
        self.systemName = systemName
        self.tint = tint
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.52, weight: .semibold))
            .foregroundStyle(tint.glyph)
            .frame(width: size, height: size)
            .background(tint.fill, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: - Feedback

private struct T3HapticsEnabledKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    /// Mirrors Settings → Haptics. Set once at the root.
    var t3HapticsEnabled: Bool {
        get { self[T3HapticsEnabledKey.self] }
        set { self[T3HapticsEnabledKey.self] = newValue }
    }
}

extension View {
    /// `.sensoryFeedback` that respects Settings → Haptics.
    func t3SensoryFeedback<Trigger: Equatable>(
        _ feedback: SensoryFeedback,
        trigger: Trigger
    ) -> some View {
        modifier(T3SensoryFeedbackModifier(feedback: feedback, trigger: trigger))
    }
}

private struct T3SensoryFeedbackModifier<Trigger: Equatable>: ViewModifier {
    let feedback: SensoryFeedback
    let trigger: Trigger
    @SwiftUI.Environment(\.t3HapticsEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content.sensoryFeedback(trigger: trigger) { _, _ in
            isEnabled ? feedback : nil
        }
    }
}

/// A transient glass confirmation for results that are otherwise invisible,
/// such as a copy. It sits in its own pass-through window so it shows above
/// sheets, never takes a touch, and is announced to VoiceOver. Pair it with a
/// haptic; never use a modal alert to say something worked.
@MainActor
enum T3HUD {
    private static var window: UIWindow?
    private static var hideTask: Task<Void, Never>?

    /// `haptic` is the notification feedback that accompanies the HUD; pass
    /// `nil` when the action that led here already played its own.
    static func show(
        _ message: String,
        systemImage: String = "checkmark.circle.fill",
        haptic: PlatformFeedbackKind? = .success
    ) {
        if let haptic { PlatformHapticEngine.shared.play(haptic) }
        AccessibilityNotification.Announcement(message).post()
        guard let scene = activeScene else { return }

        hideTask?.cancel()
        let host = UIHostingController(rootView: T3HUDView(message: message, systemImage: systemImage))
        host.view.backgroundColor = .clear

        let hudWindow = window ?? UIWindow(windowScene: scene)
        hudWindow.windowLevel = .alert + 1
        hudWindow.isUserInteractionEnabled = false
        hudWindow.overrideUserInterfaceStyle = scene.keyWindow?.traitCollection.userInterfaceStyle ?? .unspecified
        hudWindow.rootViewController = host
        let isAppearing = window == nil
        window = hudWindow
        if isAppearing {
            hudWindow.alpha = 0
            hudWindow.isHidden = false
            UIView.animate(withDuration: 0.2) { hudWindow.alpha = 1 }
        }

        hideTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.6))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    private static func hide() {
        guard let hudWindow = window else { return }
        UIView.animate(withDuration: 0.25) {
            hudWindow.alpha = 0
        } completion: { _ in
            guard window === hudWindow else { return }
            hudWindow.isHidden = true
            window = nil
        }
    }

    private static var activeScene: UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    }
}

private struct T3HUDView: View {
    let message: String
    let systemImage: String

    var body: some View {
        Label(message, systemImage: systemImage)
            .font(T3Typography.control.weight(.semibold))
            .foregroundStyle(T3Colors.textPrimary)
            .symbolRenderingMode(.hierarchical)
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .t3GlassEffect(in: Capsule())
            .t3GlassRim(in: Capsule())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .padding(.top, 8)
            .accessibilityHidden(true)
    }
}
