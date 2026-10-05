import SwiftUI

/// How conversations read on this device. Ported from
/// apps/mobile/src/features/settings/appearance/sections/ThreadAppearanceSection.tsx,
/// which matches the web client's "Activity detail" setting.
struct SettingsThreadsView: View {
    @Binding var settings: FeatureSettings
    var saveError: String?
    @AppStorage(HomeWorkingSection.enabledKey) private var isWorkingSectionEnabled = false

    var body: some View {
        SettingsForm {
            Section {
                Picker("Diff Colors", selection: $settings.diffColorScheme) {
                    Text("Red & Green").tag(FeatureDiffColorScheme.redGreen)
                    Text("Blue & Orange").tag(FeatureDiffColorScheme.blueOrange)
                }
                .pickerStyle(.menu)
            } footer: {
                SettingsFooter(error: saveError)
            }

            Section {
                Toggle("Activity Detail", isOn: $settings.alwaysExpandActivity)
            } footer: {
                Text("Keeps every tool call and reasoning step expanded on settled turns.")
            }

            Section {
                Toggle("Working Section", isOn: $isWorkingSectionEnabled)
            } header: {
                Text("Beta")
            } footer: {
                Text(
                    "Moves threads that are working, or waiting on subagents or monitors, "
                        + "into a Working section on Home until they finish or need you. Threads that "
                        + "come back are listed newest first, so arranging the list is paused. "
                        + "Applies to this device only."
                )
            }
        }
        .navigationTitle("Chat")
        .navigationBarTitleDisplayMode(.inline)
    }
}
