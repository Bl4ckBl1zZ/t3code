import Foundation
import Testing
@testable import T3Code

@Suite("Composer prompt recall")
struct ComposerPromptHistoryTests {
    @Test func neverOverwritesAnEditedRecall() {
        let entries = [ComposerPromptHistory.Entry(id: "1", prompt: "first"), .init(id: "2", prompt: "second")]
        var history = ComposerPromptHistory()
        #expect(history.step(backward: true, entries: entries, current: "unsent") == nil)
        #expect(history.step(backward: true, entries: entries, current: "") == "second")
        #expect(history.step(backward: true, entries: entries, current: "edited second") == nil)
        #expect(history.step(backward: true, entries: entries, current: "second") == "first")
        #expect(history.step(backward: false, entries: entries, current: "first") == "second")
        #expect(history.step(backward: false, entries: entries, current: "second") == "")
    }

    @Test func stripsOnlyTrailingGeneratedContext() {
        #expect(ComposerPromptHistory.recallable("Ultrathink:\nFix this @terminal-1:2-4\n<terminal_context>\n- Terminal 1 lines 2-4:\nerror\n</terminal_context>") == "Fix this")
        #expect(ComposerPromptHistory.recallable("<review_comment>example</review_comment> keep this\n<review_comment>generated</review_comment>") == "<review_comment>example</review_comment> keep this")
        #expect(ComposerPromptHistory.recallable("PLEASE IMPLEMENT THIS PLAN:\nGenerated plan") == "")
    }

    @Test func stashSwapSurvivesRestartAndPreservesAttachments() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("drafts.json")
        let store = FeatureComposerDraftStore(fileURL: url)
        let key = "environment:a:thread:b"
        let draft = FeatureComposerDraft(text: "first", attachments: [.init(data: Data([1, 2]), thumbnailData: nil, filename: "a.png", mimeType: "image/png")])
        #expect(try await store.swapStash(draft, for: key) == FeatureComposerDraft())
        let restarted = FeatureComposerDraftStore(fileURL: url)
        #expect(try await restarted.swapStash(.init(text: "second"), for: key) == draft)
        #expect(try await restarted.draft(for: key) == draft)
        #expect(try await restarted.stashedDraft(for: key)?.text == "second")
        try await restarted.removeDrafts(environmentID: "a")
        #expect(try await restarted.stashedDraft(for: key) == nil)
    }
}
