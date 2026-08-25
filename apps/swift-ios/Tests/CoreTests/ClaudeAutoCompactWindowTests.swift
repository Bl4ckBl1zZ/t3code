import XCTest
@testable import T3Code

final class ClaudeAutoCompactWindowTests: XCTestCase {
    func testAcceptsTheRangeTheServerAccepts() {
        for value in ["100000", "300000", "1000000"] {
            XCTAssertEqual(ClaudeAutoCompactWindow.normalize(value), .success(value))
        }
    }

    func testAcceptsTheGroupedTextTheRowDisplays() {
        // The field is seeded from `editableText`, so what it hands back has to
        // survive a round trip unchanged.
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("300,000"), .success("300000"))
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize(" 1,000,000 "), .success("1000000"))
    }

    func testEmptyIsClaudesDefaultRatherThanMissingInput() {
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize(""), .success(""))
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("   "), .success(""))
    }

    func testRejectsWhatTheServerWouldReject() {
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("99999"), .failure(.outOfRange))
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("1000001"), .failure(.outOfRange))
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("300k"), .failure(.notANumber))
        XCTAssertEqual(ClaudeAutoCompactWindow.normalize("-300000"), .failure(.notANumber))
    }

    func testSummaryDistinguishesAThresholdFromClaudesDefault() {
        XCTAssertEqual(ClaudeAutoCompactWindow.summary(for: ""), "Claude's default")
        XCTAssertEqual(ClaudeAutoCompactWindow.summary(for: "300000"), "300,000 tokens")
        XCTAssertEqual(ClaudeAutoCompactWindow.editableText(for: ""), "")
        XCTAssertEqual(ClaudeAutoCompactWindow.editableText(for: "300000"), "300,000")
    }

    func testSnapshotReadsTheNestedProviderSetting() throws {
        let json = """
        {
          "defaultThreadEnvMode": "local",
          "newWorktreesStartFromOrigin": true,
          "providers": {
            "claudeAgent": {"binaryPath": "/usr/local/bin/claude", "autoCompactWindow": "300000"},
            "codex": {"binaryPath": "/usr/local/bin/codex"}
          }
        }
        """
        let snapshot = try JSONDecoder.t3.decode(
            ServerSettingsSnapshot.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(snapshot.claudeAutoCompactWindow, "300000")

        // A server predating the setting, and one whose Claude settings are
        // absent entirely, both mean "Claude's default" rather than a decode
        // failure that would take the whole snapshot down with it.
        let legacy = """
        {"defaultThreadEnvMode": "local", "newWorktreesStartFromOrigin": true}
        """
        XCTAssertEqual(
            try JSONDecoder.t3.decode(ServerSettingsSnapshot.self, from: Data(legacy.utf8))
                .claudeAutoCompactWindow,
            ""
        )
    }

    func testPatchNamesOnlyTheLeafItChanges() {
        // The server deep-merges: naming the whole provider object would wipe
        // Claude's binary path and launch arguments.
        XCTAssertEqual(
            ServerSettingsPatchInput(claudeAutoCompactWindow: "300000").json,
            .object([
                "providers": .object([
                    "claudeAgent": .object(["autoCompactWindow": .string("300000")]),
                ]),
            ])
        )
        XCTAssertTrue(ServerSettingsPatchInput().isEmpty)
        // Empty is a value, not an absence: it is how the row goes back to
        // Claude's default.
        XCTAssertFalse(ServerSettingsPatchInput(claudeAutoCompactWindow: "").isEmpty)
    }
}
