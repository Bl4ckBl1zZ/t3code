import Foundation

// Ported from apps/mobile/src/lib/runtimeModeMenu.ts, together with the
// HERMES_RUNTIME_MODE_CHOICES it reads out of packages/shared/src/runtimeModes.ts.

/// One of the access options a T3 Work (Hermes) thread offers.
///
/// Hermes runs its own gate on the commands it considers dangerous, and its
/// session protocol carries no approval or sandbox setting to relax it, so the
/// four generic modes collapse to the two things T3 can actually do with an
/// `approval.request`: answer it, or show it. Supervised, auto-accept edits and
/// auto would all behave identically here, so the picker offers this pair rather
/// than three labels promising distinctions Hermes does not make.
public struct HermesRuntimeModeChoice: Equatable, Sendable {
    public let mode: RuntimeMode
    public let label: String
    public let description: String
}

public enum HermesRuntimeModes {
    public static let choices: [HermesRuntimeModeChoice] = [
        HermesRuntimeModeChoice(
            mode: .approvalRequired,
            label: "Approve risky commands",
            description: "Hermes asks before running anything it flags as dangerous."
        ),
        HermesRuntimeModeChoice(
            mode: .fullAccess,
            label: "Full access",
            description: "Let Hermes run commands without asking."
        ),
    ]

    /// The choice a Hermes thread's stored mode displays as. A thread can carry
    /// `auto` or `autoAcceptEdits` in from wherever it was created; both ask on
    /// Hermes, so both read as the approval choice rather than as a label the
    /// picker does not offer.
    public static func choice(for mode: RuntimeMode) -> HermesRuntimeModeChoice {
        choices.first { $0.mode == mode } ?? choices[0]
    }
}

public struct RuntimeModeMenuOption: Equatable, Sendable {
    public let mode: RuntimeMode
    public let title: String
}

/// The Runtime menu entry for a thread.
public struct RuntimeModeMenu: Equatable, Sendable {
    public let options: [RuntimeModeMenuOption]
    public let selected: RuntimeModeMenuOption

    /// Mobile labels the first mode "Approve actions" rather than web's
    /// "Supervised".
    private static let defaultOptions: [RuntimeModeMenuOption] = [
        RuntimeModeMenuOption(mode: .approvalRequired, title: "Approve actions"),
        RuntimeModeMenuOption(mode: .autoAcceptEdits, title: "Auto-accept edits"),
        RuntimeModeMenuOption(mode: .auto, title: "Auto"),
        RuntimeModeMenuOption(mode: .fullAccess, title: "Full access"),
    ]

    private static let hermesOptions: [RuntimeModeMenuOption] = HermesRuntimeModes.choices.map {
        RuntimeModeMenuOption(mode: $0.mode, title: $0.label)
    }

    /// T3 Work (Hermes) threads get the two options Hermes actually
    /// distinguishes; everything else gets the four generic modes. A mode
    /// outside the offered set still has to read as something, since a thread
    /// can carry one in from wherever it was created.
    public static func resolve(isHermes: Bool, runtimeMode: RuntimeMode) -> RuntimeModeMenu {
        if isHermes {
            let mode = HermesRuntimeModes.choice(for: runtimeMode).mode
            return RuntimeModeMenu(
                options: hermesOptions,
                selected: hermesOptions.first { $0.mode == mode } ?? hermesOptions[0]
            )
        }
        return RuntimeModeMenu(
            options: defaultOptions,
            selected: defaultOptions.first { $0.mode == runtimeMode } ?? defaultOptions[0]
        )
    }
}
