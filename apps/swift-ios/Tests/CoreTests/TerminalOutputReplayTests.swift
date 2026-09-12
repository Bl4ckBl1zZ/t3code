import Foundation
import Testing
@testable import T3Code

struct TerminalOutputReplayTests {
    @Test func appendsAfterRetainedHistoryRollsOver() {
        let previous = FeatureTerminalOutputCursor(byteOffset: 5)
        let next = FeatureTerminalOutputCursor(generation: previous.generation, byteOffset: 11)
        #expect(TerminalOutputReplay.update(buffer: "lo world", cursor: next, previousBuffer: "hello", previousCursor: previous) == .append(Data(" world".utf8)))
    }

    @Test func identicalRetainedTextStillDeliversNewOutput() {
        let previous = FeatureTerminalOutputCursor(byteOffset: 10)
        let next = FeatureTerminalOutputCursor(generation: previous.generation, byteOffset: 13)
        #expect(TerminalOutputReplay.update(buffer: "xxxxx", cursor: next, previousBuffer: "xxxxx", previousCursor: previous) == .append(Data("xxx".utf8)))
    }

    @Test func newAttachOrClearResetsEvenWithIdenticalText() {
        let previous = FeatureTerminalOutputCursor(byteOffset: 5)
        let next = FeatureTerminalOutputCursor(byteOffset: 5)
        #expect(TerminalOutputReplay.update(buffer: "hello", cursor: next, previousBuffer: "hello", previousCursor: previous) == .reset)
    }

    @Test func staleCursorReplaysOnceThenUnicodeAppendsByBytes() {
        let previous = FeatureTerminalOutputCursor(byteOffset: 0)
        let recovered = FeatureTerminalOutputCursor(generation: previous.generation, byteOffset: 100)
        #expect(TerminalOutputReplay.update(buffer: "tail", cursor: recovered, previousBuffer: "", previousCursor: previous) == .reset)
        let next = FeatureTerminalOutputCursor(generation: previous.generation, byteOffset: 107)
        #expect(TerminalOutputReplay.update(buffer: "tail界🙂", cursor: next, previousBuffer: "tail", previousCursor: recovered) == .append(Data("界🙂".utf8)))
        #expect(TerminalOutputReplay.update(buffer: "tail界🙂", cursor: next, previousBuffer: "tail界🙂", previousCursor: next) == .none)
    }
}
