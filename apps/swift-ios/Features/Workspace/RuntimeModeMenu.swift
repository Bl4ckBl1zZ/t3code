import Foundation

// Ported from apps/mobile/src/lib/runtimeModeMenu.ts.

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

    /// The generic modes the provider supports (all four when it lists none).
    /// A mode outside the offered set still has to read as something, since a
    /// thread can carry one in from wherever it was created; it reads as the
    /// first offered mode, which is the mode the server runs it in.
    public static func resolve(
        runtimeMode: RuntimeMode,
        supportedRuntimeModes: [RuntimeMode]? = nil
    ) -> RuntimeModeMenu {
        let supported = defaultOptions.filter { supportedRuntimeModes?.contains($0.mode) == true }
        let options = supported.isEmpty ? defaultOptions : supported
        return RuntimeModeMenu(
            options: options,
            selected: options.first { $0.mode == runtimeMode } ?? options[0]
        )
    }
}
