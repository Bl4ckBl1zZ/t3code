import Foundation
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
