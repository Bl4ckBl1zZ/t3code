import SwiftUI

/// How threads read and behave on this device. Ported from
/// apps/mobile/src/features/settings/appearance/sections/ThreadAppearanceSection.tsx,
/// which matches the web client's "Activity detail" and "Show skills in slash
/// menu" settings; "Confirm before unpinning" joins them because it is also
/// about the thread list rather than the device.
struct SettingsThreadsView: View {
    @Binding var settings: FeatureSettings
    var saveError: String?

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
                Toggle("Skills in Slash Menu", isOn: $settings.showSkillsInSlashMenu)
            } footer: {
                Text("Skills always appear when you type $. Turn this on to also list them under /.")
            }

            Section {
                Toggle("Confirm Before Unpinning", isOn: $settings.confirmThreadUnpin)
            } footer: {
                Text("Asks before a thread leaves the pinned shelf.")
            }
        }
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.inline)
    }
}
