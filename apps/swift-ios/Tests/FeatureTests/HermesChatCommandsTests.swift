import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/hermesChatCommands.test.ts.
final class HermesChatCommandsTests: XCTestCase {
    func testInterceptsTheBareFreshChatCommandsInAHermesConversation() {
        for text in ["/new", "/reset", "  /NEW  ", "/Reset"] {
            XCTAssertTrue(
                HermesChatCommands.isFreshChatCommand(text: text, isHermesConversation: true),
                "expected \(text) to start a fresh chat"
            )
        }
    }

    func testTreatsACommandWithTrailingTextAsARealMessage() {
        // Swallowing this would silently discard "plan the week".
        for text in ["/new plan the week", "/reset now", "please /new"] {
            XCTAssertFalse(
                HermesChatCommands.isFreshChatCommand(text: text, isHermesConversation: true),
                "expected \(text) to send as a message"
            )
            XCTAssertNil(HermesChatCommands.resolve(text: text, isHermesConversation: true))
        }
    }

    func testInterceptsClearOnlyInAHermesConversation() {
        XCTAssertTrue(
            HermesChatCommands.isClearChatCommand(text: "/clear", isHermesConversation: true)
        )
        XCTAssertFalse(
            HermesChatCommands.isClearChatCommand(text: "/clear", isHermesConversation: false)
        )
    }

    func testNeverInterceptsAnythingInACodeConversation() {
        for text in ["/new", "/reset", "/clear"] {
            XCTAssertNil(HermesChatCommands.resolve(text: text, isHermesConversation: false))
        }
    }

    func testResolvesEachCommandKind() {
        XCTAssertEqual(
            HermesChatCommands.resolve(text: "/new", isHermesConversation: true),
            .freshChat
        )
        XCTAssertEqual(
            HermesChatCommands.resolve(text: "/clear", isHermesConversation: true),
            .clearTimeline
        )
        XCTAssertNil(HermesChatCommands.resolve(text: "hello", isHermesConversation: true))
    }
}
