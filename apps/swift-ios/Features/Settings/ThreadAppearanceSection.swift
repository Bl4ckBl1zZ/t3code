import SwiftUI

/// Ported from
/// apps/mobile/src/features/settings/appearance/sections/ThreadAppearanceSection.tsx,
/// which matches the web client's "Activity detail" setting: a settled turn
/// keeps its tool calls and reasoning steps in the feed instead of folding them
/// away once the turn finishes.
///
/// A section rather than a screen because it is one toggle — drop it into the
/// appearance area of the settings sheet alongside the theme picker.
struct ThreadAppearanceSection: View {
    @Binding var alwaysExpandActivity: Bool

    var body: some View {
        SettingsSection(
            title: "Threads",
            footer: "Keeps every tool call and reasoning step expanded on settled turns."
        ) {
            SettingsToggleRow(
                title: "Activity detail",
                systemImage: "list.bullet.indent",
                isOn: $alwaysExpandActivity
            )
        }
    }
}
