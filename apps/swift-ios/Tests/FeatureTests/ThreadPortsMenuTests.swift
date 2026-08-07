import XCTest

@testable import T3Code

/// Ports apps/mobile/src/features/threads/threadPortsMenu.test.ts. Both clients
/// read the same endpoint merge, so a port row has to describe itself the same
/// way in both — above all the rule that a row never shows the announced
/// `localhost:PORT`, which on a phone names the handset.
final class ThreadPortsMenuTests: XCTestCase {
    private func endpoint(
        key: String = "5173",
        url: String = "http://localhost:5173/",
        host: String = "localhost",
        port: Int = 5173,
        status: ThreadEndpointStatus = .live,
        source: ThreadEndpointSource = .stdout,
        terminalID: String? = "term-1",
        scriptID: String? = nil,
        processName: String? = nil,
        pinned: Bool = false,
        local: Bool = true,
        firstSeenAtMs: Int = 0,
        reachability: EndpointReachability = .reachable(
            url: "http://192.168.1.24:5173/",
            via: .privateNetwork
        ),
        displayAddress: String? = "192.168.1.24:5173"
    ) -> ThreadEndpoint {
        ThreadEndpoint(
            key: key,
            url: url,
            host: host,
            port: port,
            status: status,
            source: source,
            terminalID: terminalID,
            scriptID: scriptID,
            processName: processName,
            pinned: pinned,
            local: local,
            firstSeenAtMs: firstSeenAtMs,
            reachability: reachability,
            displayAddress: displayAddress
        )
    }

    /// The project's `t3.json` `previewUrl`, pointing at a remote origin.
    private func pinnedRemote(
        status: ThreadEndpointStatus = .idle,
        scriptID: String? = nil,
        host: String = "wt1.8u9yhy8fewf.org",
        port: Int = 443,
        local: Bool = false,
        displayAddress: String? = "wt1.8u9yhy8fewf.org"
    ) -> ThreadEndpoint {
        endpoint(
            key: "wt1.8u9yhy8fewf.org:443",
            url: "https://wt1.8u9yhy8fewf.org/",
            host: host,
            port: port,
            status: status,
            source: .declared,
            terminalID: nil,
            scriptID: scriptID,
            pinned: true,
            local: local,
            reachability: .reachable(url: "https://wt1.8u9yhy8fewf.org/", via: .direct),
            displayAddress: displayAddress
        )
    }

    private func script(id: String = "dev", name: String = "Dev") -> ProjectScript {
        ProjectScript(
            id: id,
            name: name,
            command: "pnpm dev",
            icon: "play",
            runOnWorktreeCreate: false,
            previewUrl: nil,
            autoOpenPreview: nil
        )
    }

    // MARK: - Label

    func testLabelPrefersTheScriptTheUserRan() {
        XCTAssertEqual(
            ThreadPortsMenu.label(for: endpoint(scriptID: "dev"), scripts: [script()]),
            "Dev"
        )
    }

    func testLabelFallsBackToTheServingProcess() {
        XCTAssertEqual(
            ThreadPortsMenu.label(for: endpoint(processName: "node"), scripts: []),
            "node"
        )
    }

    func testLabelFallsBackToTheBarePort() {
        XCTAssertEqual(ThreadPortsMenu.label(for: endpoint(), scripts: []), "Port 5173")
    }

    func testLabelIgnoresAScriptIDThatNoLongerResolves() {
        XCTAssertEqual(
            ThreadPortsMenu.label(for: endpoint(scriptID: "deleted"), scripts: [script()]),
            "Port 5173"
        )
    }

    // MARK: - Pinned remote origins

    func testPinnedRemoteIsNamedByHostSinceNoScriptOrProcessAnnouncedIt() {
        // "Port 443" would say nothing about which host the row opens.
        XCTAssertEqual(
            ThreadPortsMenu.label(for: pinnedRemote(), scripts: []),
            "wt1.8u9yhy8fewf.org"
        )
    }

    func testPinnedRemoteStillPrefersAScriptNameWhenARunAdoptsTheURL() {
        XCTAssertEqual(
            ThreadPortsMenu.label(for: pinnedRemote(scriptID: "dev"), scripts: [script()]),
            "Dev"
        )
    }

    func testPinnedRemoteReportsConfigurationRatherThanClaimingItIsNotRunning() {
        // Neither liveness signal can see a remote host, so "not running" would
        // be an assertion the app has no evidence for.
        let subtitle = ThreadPortsMenu.subtitle(for: pinnedRemote())
        XCTAssertEqual(subtitle, "Pinned")
        XCTAssertFalse(subtitle.contains("not running"))
    }

    func testPinnedLocalPortStillSaysNotRunningBecauseThatIsObservable() {
        XCTAssertEqual(
            ThreadPortsMenu.subtitle(
                for: pinnedRemote(
                    host: "localhost",
                    port: 3000,
                    local: true,
                    displayAddress: "192.168.1.24:3000"
                )
            ),
            "192.168.1.24:3000 · not running"
        )
    }

    func testPinnedRemoteLabelsTheAddressOnceSomethingServesIt() {
        XCTAssertEqual(
            ThreadPortsMenu.subtitle(for: pinnedRemote(status: .live)),
            "Pinned · wt1.8u9yhy8fewf.org"
        )
    }

    func testPinnedRemoteKeepsThePinWhileIdleInsteadOfTheSleepingIcon() {
        XCTAssertEqual(ThreadPortsMenu.icon(for: pinnedRemote()), "pin.fill")
        XCTAssertEqual(ThreadPortsMenu.icon(for: pinnedRemote(status: .live)), "pin.fill")
    }

    func testPinnedRemoteIsOpenableWithoutTintingTheToolbarAsIfSomethingWereServing() {
        XCTAssertEqual(ThreadPortsMenu.openable([pinnedRemote()]).count, 1)
        XCTAssertNil(ThreadPortsMenu.tintColor(for: [pinnedRemote()]))
    }

    // MARK: - Subtitle

    func testSubtitleShowsTheResolvedAddressNeverTheAnnouncedOne() {
        // localhost would name the phone, not the machine running the server.
        let subtitle = ThreadPortsMenu.subtitle(for: endpoint())
        XCTAssertEqual(subtitle, "192.168.1.24:5173")
        XCTAssertFalse(subtitle.contains("localhost"))
    }

    func testSubtitleExplainsAnUnreachableEndpointInsteadOfOfferingAnAddress() {
        XCTAssertEqual(
            ThreadPortsMenu.subtitle(
                for: endpoint(
                    reachability: .unreachable(reason: "Not directly reachable."),
                    displayAddress: nil
                )
            ),
            "Not directly reachable."
        )
    }

    func testSubtitleReportsAStartingEndpoint() {
        XCTAssertEqual(ThreadPortsMenu.subtitle(for: endpoint(status: .starting)), "Starting…")
    }

    func testSubtitleMarksAStaleEndpointAlongsideItsAddress() {
        XCTAssertEqual(
            ThreadPortsMenu.subtitle(for: endpoint(status: .stale)),
            "192.168.1.24:5173 · no longer responding"
        )
    }

    // MARK: - Icon

    func testIconMapsStateToASymbol() {
        let cases: [(ThreadEndpoint, String)] = [
            (endpoint(), "globe"),
            (endpoint(status: .starting), "clock"),
            (endpoint(status: .stale), "moon.zzz"),
            (endpoint(reachability: .unreachable(reason: "x")), "exclamationmark.triangle"),
        ]
        for (input, expected) in cases {
            XCTAssertEqual(ThreadPortsMenu.icon(for: input), expected)
        }
    }

    func testIconPrioritisesUnreachableOverStatusSoTheWarningIsNeverHidden() {
        XCTAssertEqual(
            ThreadPortsMenu.icon(
                for: endpoint(status: .live, reachability: .unreachable(reason: "x"))
            ),
            "exclamationmark.triangle"
        )
    }

    // MARK: - Tint

    func testTintsTheToolbarIconOnceSomethingIsLive() {
        XCTAssertEqual(ThreadPortsMenu.tintColor(for: [endpoint()]), ThreadPortsMenu.liveTint)
    }

    func testStaysUntintedWhileEverythingIsStillStarting() {
        XCTAssertNil(ThreadPortsMenu.tintColor(for: [endpoint(status: .starting)]))
    }

    func testStaysUntintedWhenNothingIsServing() {
        XCTAssertNil(ThreadPortsMenu.tintColor(for: []))
    }

    // MARK: - Accessibility label

    func testAccessibilityLabelSingularises() {
        XCTAssertEqual(
            ThreadPortsMenu.accessibilityLabel(for: [endpoint()]),
            "1 port in this thread"
        )
    }

    func testAccessibilityLabelPluralises() {
        XCTAssertEqual(
            ThreadPortsMenu.accessibilityLabel(
                for: [endpoint(), endpoint(key: "3000", port: 3000)]
            ),
            "2 ports in this thread"
        )
    }

    func testAccessibilityLabelDoesNotClaimAStartingOrStalePortIsServing() {
        let label = ThreadPortsMenu.accessibilityLabel(
            for: [
                endpoint(status: .starting),
                endpoint(key: "3000", port: 3000, status: .stale),
            ]
        )
        XCTAssertFalse(label.contains("serving"))
    }

    // MARK: - Openable

    func testOpenableExcludesUnreachableAndStaleEntries() {
        let rows = [
            endpoint(key: "5173"),
            endpoint(key: "3000", status: .stale),
            endpoint(key: "4000", reachability: .unreachable(reason: "x")),
        ]
        XCTAssertEqual(ThreadPortsMenu.openable(rows).map(\.key), ["5173"])
    }
}
