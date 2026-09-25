import SwiftUI
import UIKit
import UserNotifications

/// Notifications and Live Activities, with what iOS itself allows. The app's
/// switch is only half the answer: a switch left on while iOS has notifications
/// turned off would promise alerts that never arrive.
struct SettingsNotificationsView: View {
    @Binding var settings: FeatureSettings
    var saveError: String?

    @SwiftUI.Environment(\.openURL) private var openURL
    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    /// `nil` until iOS answers, so the page never claims a permission state it
    /// has not read yet.
    @State private var authorization: UNAuthorizationStatus?

    private var isDeniedByIOS: Bool { authorization == .denied }

    var body: some View {
        SettingsForm {
            Section {
                Toggle("Notifications", isOn: $settings.notificationsEnabled)
                    .disabled(isDeniedByIOS)
                if isDeniedByIOS {
                    LabeledContent("iOS Permission") {
                        Text("Off in iOS Settings").foregroundStyle(T3Colors.warning)
                    }
                    Button("Open iOS Settings") { openSystemSettings() }
                }
            } footer: {
                SettingsFooter(
                    text: isDeniedByIOS
                        ? "iOS is blocking notifications from T3 Code. Allow them in iOS Settings, then turn this on."
                        : "Alerts when an agent finishes or needs your input.",
                    error: saveError
                )
            }

            Section {
                Toggle("Needs Your Input", isOn: $settings.notifyOnAttention)
                Toggle("Finished", isOn: $settings.notifyOnCompletion)
                Toggle("Failed", isOn: $settings.notifyOnFailure)
            } header: {
                Text("Notify When a Task")
            } footer: {
                Text("Needs Your Input covers approvals and questions from the agent.")
            }
            .disabled(!settings.notificationsEnabled || isDeniedByIOS)

            Section {
                Toggle("Live Activities", isOn: $settings.liveActivitiesEnabled)
            } footer: {
                Text("Shows running work on the Lock Screen and in the Dynamic Island.")
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scenePhase) {
            // Re-read on return from iOS Settings, where the answer may have changed.
            guard scenePhase == .active else { return }
            authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        openURL(url)
    }
}
