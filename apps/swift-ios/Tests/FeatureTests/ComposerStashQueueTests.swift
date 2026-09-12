import Foundation
import Testing
@testable import T3Code

@Suite("Composer stash queue")
struct ComposerStashQueueTests {
    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("drafts.json")
    }

    @Test func repeatedStashesAndRestorePreserveAllDraftsAndAttachments() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        let key = "environment:e:thread:t"
        let attachment = FeatureDraftAttachment(data: Data([1, 2]), filename: "test.pdf", mimeType: "application/pdf")
        let first = FeatureComposerDraft(text: "First", attachments: [attachment])
        _ = try await store.stashDraft(first, for: key)
        let queue = try await store.stashDraft(FeatureComposerDraft(text: "Second"), for: key)
        #expect(queue.map(\.draft.text) == ["First", "Second"])
        #expect(try await store.draft(for: key) == nil)
        let reloaded = FeatureComposerDraftStore(fileURL: url)
        let restored = try await reloaded.restoreStash(id: queue[0].id, replacing: FeatureComposerDraft(text: "Unsent"), for: key)
        #expect(restored == first)
        #expect(try await reloaded.stashEntries(for: key).map(\.draft.text) == ["Second", "Unsent"])
        #expect(try await FeatureComposerDraftStore(fileURL: url).draft(for: key) == first)
    }

    @Test func migratesSingleSlotOnlyOnceAndKeepsOtherEnvironments() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        let key = "environment:e:thread:t"
        _ = try await store.swapStash(FeatureComposerDraft(text: "Legacy"), for: key)
        #expect(try await store.stashEntries(for: key).map(\.draft.text) == ["Legacy"])
        _ = try await store.stashDraft(FeatureComposerDraft(text: "New"), for: key)
        _ = try await store.stashDraft(FeatureComposerDraft(text: "Other"), for: "environment:other:thread:t")
        let reloaded = FeatureComposerDraftStore(fileURL: url)
        #expect(try await reloaded.stashEntries(for: key).map(\.draft.text) == ["Legacy", "New"])
        try await reloaded.removeDrafts(environmentID: "e")
        #expect(try await reloaded.stashEntries(for: key).isEmpty)
        #expect(try await reloaded.stashEntries(for: "environment:other:thread:t").map(\.draft.text) == ["Other"])
    }

    @Test func deletingOneEntryAndStaleRestoreLeaveComposerUntouched() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        let queue = try await store.stashDraft(FeatureComposerDraft(text: "Saved"), for: "k")
        try await store.setDraft(FeatureComposerDraft(text: "Keep"), for: "k")
        #expect(try await store.removeStash(id: queue[0].id, for: "k").isEmpty)
        await #expect(throws: FeatureComposerStashError.self) {
            try await store.restoreStash(id: queue[0].id, replacing: FeatureComposerDraft(text: "Keep"), for: "k")
        }
        #expect(try await store.draft(for: "k")?.text == "Keep")
    }

    @Test func fullQueueNeverDropsTheOldestDraft() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        for index in 0..<20 { _ = try await store.stashDraft(FeatureComposerDraft(text: "\(index)"), for: "k") }
        try await store.setDraft(FeatureComposerDraft(text: "Overflow"), for: "k")
        await #expect(throws: FeatureComposerStashError.self) { try await store.stashDraft(FeatureComposerDraft(text: "Overflow"), for: "k") }
        #expect(try await store.draft(for: "k")?.text == "Overflow")
        #expect(try await store.stashEntries(for: "k").first?.draft.text == "0")
    }

    @Test func restoringPreservesWorkspaceSettingsAndShareDeduplication() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        let selection = FeatureSelection(providerID: "codex", modelID: "gpt-5.6")
        let workspace = FeatureComposerWorkspaceDraft(mode: .worktree, branch: "feature", worktreePath: "/work", startFromOrigin: false)
        try await store.setDraft(FeatureComposerDraft(text: "Draft", selection: selection, workspace: workspace), for: "k")
        _ = try await store.importSharedContent(shareID: "share", text: "Shared", attachments: [], for: "k")
        let queue = try await store.stashDraft(FeatureComposerDraft(text: "Draft"), for: "k")
        let cleared = try await store.draft(for: "k")
        #expect(cleared?.selection == selection)
        #expect(cleared?.workspace == workspace)
        let restored = try await store.restoreStash(id: queue[0].id, replacing: FeatureComposerDraft(), for: "k")
        #expect(restored.selection == selection)
        #expect(restored.workspace == workspace)
        let repeatedShare = try await store.importSharedContent(shareID: "share", text: "Shared", attachments: [], for: "k")
        #expect(repeatedShare.text == "Draft")
    }

    @Test func failedWriteLeavesQueueAndComposerIntactInMemory() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = FeatureComposerDraftStore(fileURL: url)
        _ = try await store.stashDraft(FeatureComposerDraft(text: "Saved"), for: "k")
        try await store.setDraft(FeatureComposerDraft(text: "Unsent"), for: "k")
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        await #expect(throws: (any Error).self) { try await store.stashDraft(FeatureComposerDraft(text: "Unsent"), for: "k") }
        #expect(try await store.draft(for: "k")?.text == "Unsent")
        #expect(try await store.stashEntries(for: "k").map(\.draft.text) == ["Saved"])
    }
}
