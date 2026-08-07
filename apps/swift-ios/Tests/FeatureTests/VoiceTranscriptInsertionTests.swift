import Foundation
import XCTest

@testable import T3Code

/// Ports packages/shared/src/voiceInput.test.ts and the completion rules in
/// apps/mobile/src/features/voice/useVoiceComposer.ts.
final class VoiceTranscriptInsertionTests: XCTestCase {
    func testInsertsAtTheIntendedRange() {
        let cases: [(draft: String, range: VoiceTextRange, transcript: String, expected: String)] = [
            ("", VoiceTextRange(start: 0, end: 0), "Hello.", "Hello."),
            ("world", VoiceTextRange(start: 0, end: 0), "Hello", "Hello world"),
            ("Hello world", VoiceTextRange(start: 6, end: 11), "T3", "Hello T3"),
            ("Hello", VoiceTextRange(start: 5, end: 5), "world", "Hello world"),
        ]

        for testCase in cases {
            XCTAssertEqual(
                VoiceTranscriptInsertion.insert(
                    draft: testCase.draft,
                    range: testCase.range,
                    cleanedText: testCase.transcript
                ).text,
                testCase.expected,
                "inserting '\(testCase.transcript)' into '\(testCase.draft)'"
            )
        }
    }

    func testPlacesTheCaretAtTheEndOfTheInsertion() {
        let result = VoiceTranscriptInsertion.insert(
            draft: "Hello",
            range: VoiceTextRange(caret: 5),
            cleanedText: "world"
        )

        XCTAssertEqual(result.text, "Hello world")
        XCTAssertEqual(result.caret, 11)
    }

    /// Dictation lands mid-sentence far more often than at the end, and the
    /// caret has to follow the text so the next keystroke continues from it.
    func testInsertingMidDraftKeepsTheTailAndParksTheCaretBeforeIt() {
        let result = VoiceTranscriptInsertion.insert(
            draft: "Ship the fix today",
            range: VoiceTextRange(caret: 9),
            cleanedText: "for login"
        )

        XCTAssertEqual(result.text, "Ship the for login fix today")
        XCTAssertEqual(result.caret, 19)
    }

    func testBoundarySpacingIsAddedOnlyWhereItIsMissing() {
        // A space already present is not doubled.
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "Hello ",
                range: VoiceTextRange(caret: 6),
                cleanedText: "world"
            ).text,
            "Hello world"
        )
        // Punctuation attaches to the preceding word.
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "Hello",
                range: VoiceTextRange(caret: 5),
                cleanedText: ", world"
            ).text,
            "Hello, world"
        )
        // A transcript ending in an opening bracket attaches to what follows it.
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "ab",
                range: VoiceTextRange(caret: 1),
                cleanedText: "("
            ).text,
            "a (b"
        )
        // The transcript's own surrounding whitespace is never preserved.
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "Hello",
                range: VoiceTextRange(caret: 5),
                cleanedText: "   world  "
            ).text,
            "Hello world"
        )
    }

    func testAnEmptyTranscriptStillCollapsesTheSelection() {
        let result = VoiceTranscriptInsertion.insert(
            draft: "Hello world",
            range: VoiceTextRange(start: 5, end: 11),
            cleanedText: "   "
        )

        XCTAssertEqual(result.text, "Hello")
        XCTAssertEqual(result.caret, 5)
    }

    func testRangesOutsideTheDraftAreClamped() {
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "abc",
                range: VoiceTextRange(start: -5, end: 99),
                cleanedText: "X"
            ).text,
            "X"
        )
        // An inverted range collapses to its start rather than deleting
        // backwards.
        XCTAssertEqual(
            VoiceTranscriptInsertion.insert(
                draft: "abcdef",
                range: VoiceTextRange(start: 4, end: 1),
                cleanedText: "X"
            ).text,
            "abcd X ef"
        )
    }

    /// Offsets are UTF-16, matching `UITextInput`. Measuring in characters would
    /// place the caret inside an emoji after any non-BMP text.
    func testOffsetsAreMeasuredInUTF16CodeUnits() {
        let draft = "🙂 ok"

        let result = VoiceTranscriptInsertion.insert(
            draft: draft,
            range: VoiceTextRange(caret: draft.utf16.count),
            cleanedText: "then"
        )

        XCTAssertEqual(result.text, "🙂 ok then")
        XCTAssertEqual(result.caret, result.text.utf16.count)
    }

    // MARK: - Delivery

    func testATranscriptForTheSameComposerIsInsertedAtItsAnchor() {
        let anchor = VoiceComposerAnchor(
            identity: "env:thread-a",
            draft: "Ship the fix",
            range: VoiceTextRange(caret: 4)
        )

        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: "big",
            anchor: anchor,
            target: VoiceComposerTarget(
                identity: "env:thread-a",
                draft: "Ship the fix",
                range: VoiceTextRange(caret: 12)
            )
        )

        XCTAssertEqual(
            delivery,
            .inserted(VoiceInsertionResult(text: "Ship big the fix", caret: 8))
        )
    }

    /// A transcript belongs to the composer it was recorded against. Pushing it
    /// into whatever draft happens to be on screen would drop dictated text into
    /// somebody else's conversation.
    func testATranscriptThatLandsAfterAThreadSwitchIsStashedUnderItsOwnIdentity() {
        let anchor = VoiceComposerAnchor(
            identity: "env:thread-a",
            draft: "Ship the fix",
            range: VoiceTextRange(caret: 12)
        )

        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: "tomorrow",
            anchor: anchor,
            target: VoiceComposerTarget(
                identity: "env:thread-b",
                draft: "Different conversation",
                range: VoiceTextRange(caret: 0)
            )
        )

        XCTAssertEqual(delivery, .stashed(identity: "env:thread-a", text: "tomorrow"))
    }

    /// Typing during transcription invalidates the anchored offsets — they point
    /// into a draft that no longer exists — so the live caret wins.
    func testADraftEditedMidTranscriptionFallsBackToTheLiveCaret() {
        let anchor = VoiceComposerAnchor(
            identity: "env:thread-a",
            draft: "Ship",
            range: VoiceTextRange(caret: 0)
        )

        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: "now",
            anchor: anchor,
            target: VoiceComposerTarget(
                identity: "env:thread-a",
                draft: "Ship it",
                range: VoiceTextRange(start: 7, end: 7)
            )
        )

        XCTAssertEqual(
            delivery,
            .inserted(VoiceInsertionResult(text: "Ship it now", caret: 11))
        )
    }

    func testWithoutAnAnchorTheTranscriptIsDiscardedRatherThanGuessed() {
        XCTAssertEqual(
            VoiceTranscriptInsertion.deliver(
                transcript: "orphan",
                anchor: nil,
                target: VoiceComposerTarget(
                    identity: "env:thread-a",
                    draft: "",
                    range: .zero
                )
            ),
            .discarded
        )
    }

    // MARK: - Stash

    @MainActor
    func testTheStashHandsEachTranscriptBackExactlyOnce() {
        let stash = VoiceTranscriptStash(now: { Date(timeIntervalSince1970: 1) })

        stash.put(identity: "env:thread-a", text: "Hello world")

        XCTAssertEqual(stash.peek(identity: "env:thread-a")?.text, "Hello world")
        XCTAssertEqual(stash.take(identity: "env:thread-a")?.text, "Hello world")
        XCTAssertNil(stash.take(identity: "env:thread-a"))
        XCTAssertNil(stash.take(identity: "env:thread-b"))
    }

    @MainActor
    func testTheStashIgnoresBlankTranscriptsAndReplacesPerIdentity() {
        let stash = VoiceTranscriptStash(now: { Date(timeIntervalSince1970: 5) })

        stash.put(identity: "id", text: "   ")
        XCTAssertNil(stash.take(identity: "id"))

        stash.put(identity: "id", text: "first")
        stash.put(identity: "id", text: "second")
        XCTAssertEqual(stash.take(identity: "id")?.text, "second")
    }

    /// A transcript nobody came back for is stale text, not a pending edit:
    /// inserting it an hour later would surprise the reader.
    @MainActor
    func testStashedTranscriptsExpire() {
        var clock = Date(timeIntervalSince1970: 0)
        let stash = VoiceTranscriptStash(timeToLive: 100, now: { clock })

        stash.put(identity: "id", text: "text")
        clock = Date(timeIntervalSince1970: 101)

        XCTAssertNil(stash.take(identity: "id"))
    }

    /// The round trip the feature exists for: record against thread A, switch to
    /// B before the transcript lands, come back to A and find it in the draft.
    @MainActor
    func testARoundTripAcrossAThreadSwitchInsertsIntoTheOriginalComposer() throws {
        let stash = VoiceTranscriptStash(now: { Date(timeIntervalSince1970: 10) })
        let anchor = VoiceComposerAnchor(
            identity: "env:thread-a",
            draft: "Ship the fix",
            range: VoiceTextRange(caret: 12)
        )

        let delivery = VoiceTranscriptInsertion.deliver(
            transcript: "tomorrow",
            anchor: anchor,
            target: VoiceComposerTarget(
                identity: "env:thread-b",
                draft: "",
                range: .zero
            )
        )
        guard case let .stashed(identity, text) = delivery else {
            return XCTFail("A transcript for an inactive composer must be stashed.")
        }
        stash.put(identity: identity, text: text)

        // Thread A becomes active again with its draft as the user left it.
        let entry = stash.take(identity: "env:thread-a")
        let restored = VoiceTranscriptInsertion.insert(
            draft: "Ship the fix",
            range: VoiceTextRange(caret: 12),
            cleanedText: try XCTUnwrap(entry?.text)
        )

        XCTAssertEqual(restored.text, "Ship the fix tomorrow")
        XCTAssertNil(stash.take(identity: "env:thread-a"), "The entry is spent once inserted.")
    }
}
