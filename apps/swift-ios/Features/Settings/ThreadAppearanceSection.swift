import SwiftUI

/// Ported from
/// apps/mobile/src/features/settings/appearance/sections/ThreadAppearanceSection.tsx,
/// which matches the web client's "Activity detail" setting: a settled turn
/// keeps its tool calls and reasoning steps in the feed instead of folding them
/// away once the turn finishes. "Show skills in slash menu" is the web client's
/// companion composer setting.
///
/// A section rather than a screen because it is two toggles — drop it into the
/// appearance area of the settings sheet alongside the theme picker.
struct ThreadAppearanceSection: View {
    @Binding var alwaysExpandActivity: Bool
    @Binding var showSkillsInSlashMenu: Bool

    private static let footer = """
        Activity detail keeps every tool call and reasoning step expanded on \
        settled turns. Skills always appear when you type $; the slash menu \
        setting decides whether they also appear under /.
        """

    var body: some View {
        SettingsSection(title: "Threads", footer: Self.footer) {
            VStack(spacing: 0) {
                SettingsToggleRow(
                    title: "Activity detail",
                    systemImage: "list.bullet.indent",
                    isOn: $alwaysExpandActivity
                )
                SettingsRowDivider()
                SettingsToggleRow(
                    title: "Show skills in slash menu",
                    systemImage: "sparkles",
                    isOn: $showSkillsInSlashMenu
                )
            }
        }
    }
}
