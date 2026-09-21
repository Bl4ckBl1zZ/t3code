import Foundation
import UIKit
import XCTest
@testable import T3Code

final class ExtensionContractTests: XCTestCase {
    func testLiveActivityDecodesTheRelayAPNSEnvelope() throws {
        let props = #"{"title":"T3 Code","subtitle":"2 active agents, 1 needs attention","activeCount":2,"updatedAt":"2026-08-01T12:00:00.000Z","activities":[{"environmentId":"env-1","threadId":"thread-working","projectTitle":"t3code","threadTitle":"Build the native app","modelTitle":"GPT-5.6 Sol","phase":"running","status":"Working","updatedAt":"2026-08-01T12:00:00.000Z","deepLink":"/env-1/thread-working"},{"environmentId":"env-2","threadId":"thread-approval","projectTitle":"uploadthing","threadTitle":"Ship upload recovery","modelTitle":"Claude Opus 5","phase":"waiting_for_approval","status":"Approval","updatedAt":"2026-08-01T11:59:00.000Z","deepLink":"/env-2/thread-approval"}]}"#
        let state = LiveActivityAttributes.ContentState(
            name: "AgentActivity",
            props: props
        )

        let aggregate = try XCTUnwrap(state.aggregate)
        XCTAssertEqual(aggregate.activeCount, 2)
        XCTAssertEqual(aggregate.activities.count, 2)
        XCTAssertEqual(aggregate.attentionFirstActivities.first?.threadId, "thread-approval")
        XCTAssertEqual(
            aggregate.attentionFirstActivities.first?.nativeDeepLinkURL?.absoluteString,
            "\(T3SharedContainer.urlScheme)://threads?environment=env-2&thread=thread-approval"
        )
    }

    func testLocalLiveActivityStatePreservesTheExactNameAndPropsKeys() throws {
        let aggregate = T3RelayAgentActivityAggregateState(
            title: "T3 Code",
            subtitle: "1 active agent",
            activeCount: 1,
            updatedAt: "2026-08-01T12:00:00.000Z",
            activities: []
        )
        let state = try LiveActivityAttributes.ContentState(aggregate: aggregate)
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any]
        )

        XCTAssertEqual(Set(encoded.keys), Set(["name", "props"]))
        XCTAssertEqual(encoded["name"] as? String, "AgentActivity")
        XCTAssertEqual(state.aggregate, aggregate)
    }

    func testUnexpectedActivityNamesNeverDecodeAsAgentState() {
        let state = LiveActivityAttributes.ContentState(name: "Other", props: "{}")
        XCTAssertNil(state.aggregate)
    }

    /// The counts the OS offers and the count the app accepts live in two files
    /// and drift silently: iOS would hand the extension nine movies and the
    /// ninth would vanish with no explanation.
    func testShareActivationRulesMatchWhatTheInboxAccepts() throws {
        let rule = try Self.shareActivationRule()

        XCTAssertEqual(rule["NSExtensionActivationDictionaryVersion"] as? Int, 2)
        XCTAssertEqual(rule["NSExtensionActivationSupportsText"] as? Bool, true)
        XCTAssertEqual(rule["NSExtensionActivationSupportsWebURLWithMaxCount"] as? Int, 1)
        for key in [
            "NSExtensionActivationSupportsImageWithMaxCount",
            "NSExtensionActivationSupportsMovieWithMaxCount",
            "NSExtensionActivationSupportsFileWithMaxCount",
        ] {
            XCTAssertEqual(
                rule[key] as? Int,
                T3IncomingShareStore.maximumAttachmentCount,
                "\(key) must match the inbox's attachment cap"
            )
        }
    }

    /// The share extension is a separate module and cannot see
    /// `ComposerAttachments`, so its restated caps are pinned here — the same
    /// way the app group identifier is pinned across its three homes.
    func testInboxByteCapsMatchTheSharedComposerRules() {
        XCTAssertEqual(
            T3IncomingShareStore.maximumImageBytes,
            ComposerAttachments.maximumImageBytes
        )
        XCTAssertEqual(
            T3IncomingShareStore.maximumFileBytes,
            ComposerAttachments.maximumFileBytes
        )
        XCTAssertEqual(
            T3IncomingShareStore.maximumBytes(isImage: true),
            ComposerAttachments.maximumBytes(for: .image)
        )
        XCTAssertEqual(
            T3IncomingShareStore.maximumBytes(isImage: false),
            ComposerAttachments.maximumBytes(for: .video)
        )
    }

    /// Every phase glyph has to exist on the OS the tests run on; a name from a
    /// newer SF Symbols release renders as nothing (the running glyph did on
    /// iOS 17).
    func testEveryPhaseGlyphExistsOnThisSystem() {
        let phases: [T3AgentActivityPhase] = [
            .starting, .running, .waitingForApproval, .waitingForInput, .completed, .failed, .stale,
        ]
        for phase in phases {
            XCTAssertNotNil(UIImage(systemName: phase.systemImage), "\(phase.rawValue): \(phase.systemImage)")
        }
    }

    /// A card the system marked stale stops asserting a live state: no wash,
    /// neutral tints, and a status that says nothing has arrived.
    func testAStaleLiveActivityGoesNeutral() {
        let aggregate = T3RelayAgentActivityAggregateState(
            title: "T3 Code",
            subtitle: "1 active agent",
            activeCount: 1,
            updatedAt: "2026-08-01T12:00:00.000Z",
            activities: [Self.row(phase: .waitingForApproval, updatedAt: "2026-08-01T12:00:00.000Z")]
        )
        let live = T3AgentActivityPresentation(aggregate: aggregate)
        XCTAssertEqual(live.backgroundTint, .amber)
        XCTAssertFalse(live.isStale)

        let stale = T3AgentActivityPresentation(aggregate: aggregate, isStale: true)
        XCTAssertTrue(stale.isStale)
        XCTAssertNil(stale.backgroundTint)
        XCTAssertEqual(stale.headerTint, .neutral)
        XCTAssertEqual(stale.heroTint, .neutral)
        XCTAssertEqual(stale.shortStatus, "No update")
        XCTAssertEqual(stale.lastUpdate, T3AgentActivityTimestamp.parse("2026-08-01T12:00:00.000Z"))
    }

    /// A row left "Working" when the app died dims after the Live Activity's
    /// stale window; rows waiting on a person never go stale.
    func testOnlyWorkingRowsGoStale() throws {
        let updated = try XCTUnwrap(T3AgentActivityTimestamp.parse("2026-08-01T12:00:00.000Z"))
        let running = Self.row(phase: .running, updatedAt: "2026-08-01T12:00:00.000Z")
        XCTAssertFalse(running.isStale(at: updated.addingTimeInterval(9 * 60)))
        XCTAssertTrue(running.isStale(at: updated.addingTimeInterval(10 * 60)))

        let waiting = Self.row(phase: .waitingForInput, updatedAt: "2026-08-01T12:00:00.000Z")
        XCTAssertFalse(waiting.isStale(at: updated.addingTimeInterval(3 * 60 * 60)))
        XCTAssertNil(waiting.staleDeadline)
    }

    private static func row(phase: T3AgentActivityPhase, updatedAt: String) -> T3RelayAgentActivityAggregateRow {
        T3RelayAgentActivityAggregateRow(
            environmentId: "env",
            threadId: "thread",
            projectTitle: "t3code",
            threadTitle: "Build the native app",
            modelTitle: "Claude Opus 5",
            phase: phase,
            status: "Working",
            updatedAt: updatedAt,
            deepLink: "/env/thread"
        )
    }

    /// Reads the source-tree plist rather than a bundled copy: the extension's
    /// Info.plist is consumed by the build, not shipped into the test bundle.
    private static func shareActivationRule() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Share/Info.plist")
        let plist = try XCTUnwrap(
            try PropertyListSerialization.propertyList(
                from: Data(contentsOf: url),
                format: nil
            ) as? [String: Any]
        )
        let extensionEntry = try XCTUnwrap(plist["NSExtension"] as? [String: Any])
        let attributes = try XCTUnwrap(extensionEntry["NSExtensionAttributes"] as? [String: Any])
        return try XCTUnwrap(attributes["NSExtensionActivationRule"] as? [String: Any])
    }
}
