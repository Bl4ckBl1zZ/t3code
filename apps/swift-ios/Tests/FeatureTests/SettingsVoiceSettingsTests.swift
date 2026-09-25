import Foundation
import XCTest

@testable import T3Code

/// Covers the pure logic behind the Voice Input settings screens: the
/// integration label, the personal-dictionary text/entry round trip, and the
/// model search. Ports the behaviour of `label()` in
/// SettingsIntegrationsRouteScreen.tsx, the dictionary `onBlur` handler in
/// SettingsVoiceInputRouteScreen.tsx, and the `filtered` memo in
/// SettingsVoiceModelRouteScreen.tsx.
final class SettingsVoiceSettingsTests: XCTestCase {
    // MARK: - Integration label

    func testAnUnsettledRequestReadsAsChecking() {
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(nil, isLoaded: false),
            "Checking"
        )
        // Even a status already in hand stays "Checking" until the request
        // settles, so a stale value is never presented as current.
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: true, state: .connected),
                isLoaded: false
            ),
            "Checking"
        )
    }

    func testASettledButAbsentStatusReadsAsUnavailable() {
        XCTAssertEqual(VoiceIntegrationLabels.connection(nil, isLoaded: true), "Unavailable")
    }

    func testConnectedValidatingAndInvalidMapToTheirOwnLabels() {
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: true, state: .connected),
                isLoaded: true
            ),
            "Connected"
        )
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: true, state: .validating),
                isLoaded: true
            ),
            "Validating"
        )
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: true, state: .invalid),
                isLoaded: true
            ),
            "Error"
        )
    }

    /// A stored key the relay cannot currently use is a different problem from
    /// never having entered one, and only the second is the reader's next step.
    func testAnUnusableStoredKeyIsDistinguishedFromNoKeyAtAll() {
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: true, state: .unavailable),
                isLoaded: true
            ),
            "Unavailable"
        )
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: false, state: .notConfigured),
                isLoaded: true
            ),
            "Not Set Up"
        )
    }

    /// A client without the capability reports `.unavailable` with no key. It
    /// can never connect, so it must not read as a setup step.
    func testAnUnsupportedClientReadsAsUnavailableRatherThanNotSetUp() {
        XCTAssertEqual(
            VoiceIntegrationLabels.connection(
                OpenRouterIntegrationStatus(configured: false, state: .unavailable),
                isLoaded: true
            ),
            "Unavailable"
        )
    }

    func testAnUnparseableValidationInstantIsDroppedRatherThanShown() {
        XCTAssertNil(VoiceIntegrationLabels.validatedAt(nil))
        XCTAssertNil(VoiceIntegrationLabels.validatedAt("not a date"))
        XCTAssertNotNil(VoiceIntegrationLabels.validatedAt("2026-08-02T12:00:00.000Z"))
        // Records written before the server stamped milliseconds still parse.
        XCTAssertNotNil(VoiceIntegrationLabels.validatedAt("2026-08-02T12:00:00Z"))
    }

    // MARK: - Personal dictionary

    func testDictionaryEntriesAreTrimmedAndBlankLinesDropped() {
        XCTAssertEqual(
            VoiceInputDictionary.entries(from: "  kubectl \n\n  T3 Code\n   \nnpm\n"),
            ["kubectl", "T3 Code", "npm"]
        )
    }

    func testWindowsLineEndingsSplitTheSameWayAsUnixOnes() {
        XCTAssertEqual(
            VoiceInputDictionary.entries(from: "kubectl\r\nnpm\r\n"),
            ["kubectl", "npm"]
        )
    }

    func testDictionaryEntriesAreCappedAtTheContractMaximum() {
        let overflowing = (1...(VoiceInputSettings.maximumDictionaryEntries + 25))
            .map { "entry-\($0)" }
        let entries = VoiceInputDictionary.entries(
            from: VoiceInputDictionary.text(for: overflowing)
        )
        XCTAssertEqual(entries.count, VoiceInputSettings.maximumDictionaryEntries)
        XCTAssertEqual(entries.first, "entry-1")
        XCTAssertEqual(entries.last, "entry-\(VoiceInputSettings.maximumDictionaryEntries)")
    }

    func testDictionaryRoundTripsThroughItsTextForm() {
        let entries = ["kubectl", "T3 Code", "npm"]
        XCTAssertEqual(
            VoiceInputDictionary.entries(from: VoiceInputDictionary.text(for: entries)),
            entries
        )
    }

    /// The screen writes on blur. Comparing entry-wise rather than as raw text
    /// is what keeps trailing whitespace and stray blank lines from firing a
    /// request that would store exactly what is already stored.
    func testCosmeticEditsAreNotTreatedAsChanges() {
        let stored = ["kubectl", "npm"]
        XCTAssertFalse(VoiceInputDictionary.changes("kubectl\nnpm", from: stored))
        XCTAssertFalse(VoiceInputDictionary.changes("kubectl \n\n npm \n", from: stored))
        XCTAssertTrue(VoiceInputDictionary.changes("kubectl\nnpm\npnpm", from: stored))
        XCTAssertTrue(VoiceInputDictionary.changes("npm\nkubectl", from: stored))
    }
}
