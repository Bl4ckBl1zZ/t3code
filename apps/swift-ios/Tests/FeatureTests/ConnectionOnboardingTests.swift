import Foundation
import Testing
@testable import T3Code

@Suite("Onboarding decisions")
struct ConnectionOnboardingTests {
    @Test
    func scannerAcceptsOnlyCodesThatCarryAPairingCode() {
        let details = ConnectionDetailsParser.scannedPairingCode(
            "https://studio.example/pair#token=ABC123"
        )

        #expect(details?.endpoint == "https://studio.example")
        #expect(details?.pairingCode == "ABC123")
        #expect(ConnectionDetailsParser.scannedPairingCode("https://example.com/menu") == nil)
        #expect(ConnectionDetailsParser.scannedPairingCode("WIFI:S:Cafe;T:WPA;P:secret;;") == nil)
    }

    @Test
    func networkProblemsGetTheirOwnSectionAndOthersTheFooter() {
        #expect(ConnectionProblem.localNetworkDenied.notice?.systemImage == "wifi.slash")
        #expect(ConnectionProblem.localNetworkDenied.footerMessage == nil)
        #expect(ConnectionProblem.unreachable.notice?.message.contains("This device") == true)
        #expect(ConnectionProblem.missingCode.notice == nil)
        #expect(ConnectionProblem.missingCode.footerMessage?.contains("pairing code") == true)
        #expect(ConnectionProblem.message("Expired").footerMessage == "Expired")
    }

    @Test
    func unreachableCopyDoesNotAssumeAnIPhone() {
        let message = ConnectionErrorCopy.message(for: "Could not connect to the server.")

        #expect(message.hasPrefix("This device"))
    }

    @Test(arguments: [
        (true, true, "ready", "authenticated", "Ready", AgentSetupTone.success, nil),
        (true, true, "warning", "authenticated", "Needs attention", .warning, nil),
        (true, true, "error", "authenticated", "Error", .danger, nil),
        (true, true, "ready", "unauthenticated", "Signed out", .warning, AgentSetupProviderState.Action.signIn),
        (true, false, "error", "unknown", "Not installed", .warning, .install),
        (false, false, "ready", "unauthenticated", "Disabled", .tertiary, nil),
    ] as [(Bool, Bool, String, String, String, AgentSetupTone, AgentSetupProviderState.Action?)])
    func providerStatesReadAsWords(
        enabled: Bool,
        installed: Bool,
        status: String,
        authStatus: String,
        label: String,
        tone: AgentSetupTone,
        action: AgentSetupProviderState.Action?
    ) {
        let state = AgentSetupProviderState(
            enabled: enabled,
            installed: installed,
            status: status,
            authStatus: authStatus
        )

        #expect(state.label == label)
        #expect(state.tone == tone)
        #expect(state.action == action)
    }

    @Test
    func importSummaryOnlyCompletesWithoutSkipsOrFailures() {
        #expect(AgentImportSummary(imported: 12).isComplete)

        let partial = AgentImportSummary(imported: 41, skipped: 5, failedProjects: 3)
        #expect(!partial.isComplete)
        #expect(partial.title == "3 projects couldn’t be imported")
        #expect(AgentImportSummary(imported: 4, skipped: 2).title == "Some conversations couldn’t be imported")
    }

    @Test
    func cloudEnvironmentStatusMarksUseAndHidesRawErrors() {
        let online = T3ConnectEnvironmentStatus(environment(status: .online), isInUse: true)
        #expect(online.text == "Online · In use")
        #expect(online.tone == .success)

        let offline = T3ConnectEnvironmentStatus(environment(status: .offline), isInUse: false)
        #expect(offline.text == "Offline")
        #expect(offline.isOffline)

        let checking = T3ConnectEnvironmentStatus(environment(status: nil), isInUse: false)
        #expect(checking.text == "Checking…")

        let failed = T3ConnectEnvironmentStatus(
            environment(status: nil, statusError: "NSURLErrorDomain -1001"),
            isInUse: false
        )
        #expect(failed.text == "Status unavailable")
        #expect(!failed.isOffline)
    }

    @Test
    func missingAccessScopeIsNotRetryable() {
        let message = DeviceManagementErrorCopy.message(
            for: NSError(domain: "T3", code: 403, userInfo: [NSLocalizedDescriptionKey: "403 Forbidden"])
        )

        #expect(DeviceManagementErrorCopy.isPermissionDenied(message))
        #expect(!DeviceManagementErrorCopy.isPermissionDenied(
            DeviceManagementErrorCopy.message(for: URLError(.timedOut))
        ))
    }

    private func environment(
        status: T3ConnectRelayEnvironmentStatus.Value?,
        statusError: String? = nil
    ) -> T3ConnectCloudEnvironment {
        let endpoint = T3ConnectManagedEndpoint(
            httpBaseUrl: "https://managed.example",
            wsBaseUrl: "wss://managed.example",
            providerKind: .t3Relay
        )
        return T3ConnectCloudEnvironment(
            environment: T3ConnectRelayEnvironment(
                environmentId: "managed-1",
                label: "Studio",
                endpoint: endpoint,
                linkedAt: "2026-08-01T12:00:00.000Z"
            ),
            status: status.map {
                T3ConnectRelayEnvironmentStatus(
                    environmentId: "managed-1",
                    endpoint: endpoint,
                    status: $0,
                    checkedAt: "2026-08-01T12:00:00.000Z",
                    descriptor: nil,
                    error: nil,
                    traceId: nil
                )
            },
            statusError: statusError
        )
    }
}
