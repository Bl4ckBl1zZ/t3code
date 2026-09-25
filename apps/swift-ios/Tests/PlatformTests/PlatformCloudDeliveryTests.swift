import Foundation
import Testing
@testable import T3Code

@Suite("Cloud delivery registration")
struct PlatformCloudDeliveryTests {
    @Test
    func installationIdentityIsStableWithinAnInstall() throws {
        let suiteName = "cloud-delivery-\(UUID())"
        let suite = try #require(UserDefaults(suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }

        let first = PlatformInstallationIdentity.value(defaults: suite)
        let second = PlatformInstallationIdentity.value(defaults: suite)

        #expect(!first.isEmpty)
        #expect(first == second)
    }

    @Test
    func registrationCarriesRoutingAndUserPreferences() {
        var settings = FeatureSettings()
        settings.notificationsEnabled = false
        settings.liveActivitiesEnabled = true

        let registration = PlatformCloudDeliveryRegistrationFactory.registration(
            deviceID: "device-1",
            deviceName: "Big O",
            systemVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0),
            appVersion: "1.2.3",
            bundleID: "com.t3tools.t3code.swiftui",
            pushToken: "apns-token",
            pushToStartToken: "activity-token",
            settings: settings,
            apsEnvironment: .sandbox
        )

        #expect(registration.platform == "ios")
        #expect(registration.iosMajorVersion == 26)
        #expect(registration.bundleId == "com.t3tools.t3code.swiftui")
        #expect(registration.apsEnvironment == .sandbox)
        #expect(registration.pushToken == "apns-token")
        #expect(registration.pushToStartToken == "activity-token")
        #expect(!registration.preferences.notificationsEnabled)
        #expect(registration.preferences.liveActivitiesEnabled)
    }

    @Test
    func attentionCoversBothApprovalsAndQuestions() {
        var settings = FeatureSettings()
        settings.notifyOnAttention = false
        settings.notifyOnFailure = false

        let preferences = PlatformCloudDeliveryRegistrationFactory.registration(
            deviceID: "device-1",
            deviceName: "Big O",
            systemVersion: OperatingSystemVersion(majorVersion: 26, minorVersion: 0, patchVersion: 0),
            appVersion: nil,
            bundleID: nil,
            pushToken: nil,
            pushToStartToken: nil,
            settings: settings,
            apsEnvironment: .sandbox
        ).preferences

        #expect(!preferences.notifyOnApproval)
        #expect(!preferences.notifyOnInput)
        #expect(preferences.notifyOnCompletion)
        #expect(!preferences.notifyOnFailure)
    }

    @Test
    func localAlertsFollowTheEventChoicesAndTheMasterSwitch() {
        var settings = FeatureSettings()
        settings.notifyOnCompletion = false
        #expect(!settings.notifies(.success))
        #expect(settings.notifies(.warning))
        #expect(settings.notifies(.error))

        settings.notificationsEnabled = false
        #expect(!settings.notifies(.warning))
    }

}
