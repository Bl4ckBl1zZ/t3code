import Foundation
import Testing
@testable import T3Code

struct WorkspaceMutationRevisionTests {
    @Test func refreshesOnlyAfterPotentialFileMutationsBecomeTerminal() {
        func item(_ type: String, _ status: String, _ time: String = "2026-09-12T10:00:00.000Z") -> WorkspaceMutationItem {
            .init(sourceThreadID: "source", itemID: "item", type: type, status: status, updatedAt: time)
        }
        #expect(WorkspaceMutationRevision.latest([item("file_change", "running")]) == nil)
        #expect(WorkspaceMutationRevision.latest([item("file_change", "unknown")]) == nil)
        #expect(WorkspaceMutationRevision.latest([item("file_search", "completed")]) == nil)
        #expect(WorkspaceMutationRevision.latest([item("command_execution", "completed")]) != nil)
        // A command can partially change files before failing or being interrupted.
        #expect(WorkspaceMutationRevision.latest([item("command_execution", "failed")]) != nil)
        #expect(WorkspaceMutationRevision.latest([item("file_change", "interrupted")]) != nil)
        #expect(WorkspaceMutationRevision.latest([item("file_change", "completed", "bad")]) == nil)
    }

    @Test func scopesInheritedItemsAndUsesTimestampRatherThanRowOrder() {
        let old = WorkspaceMutationItem(sourceThreadID: "parent", itemID: "same", type: "file_change", status: "completed", updatedAt: "2026-09-12T10:00:00Z")
        let new = WorkspaceMutationItem(sourceThreadID: "child", itemID: "same", type: "command_execution", status: "completed", updatedAt: "2026-09-12T12:00:01+02:00")
        let revision = WorkspaceMutationRevision.latest([new, old])
        #expect(revision?.hasPrefix("child:same:") == true)
        #expect(WorkspaceMutationRevision.latest([old, new]) == revision)
    }

    @Test func assetRefreshPreservesSignedQueryAndReplacesOnlyItsOwnRevision() throws {
        let url = try #require(URL(string: "https://host/api/assets/file?token=signed%2Bvalue&workspace-revision=old#page=2"))
        let refreshed = WorkspaceMutationRevision.assetURL(url, revision: "thread:item:123")
        let parts = try #require(URLComponents(url: refreshed, resolvingAgainstBaseURL: false))
        #expect(parts.queryItems?.filter { $0.name == "workspace-revision" }.map(\.value) == ["thread:item:123"])
        #expect(parts.queryItems?.first { $0.name == "token" }?.value == "signed+value")
        #expect(parts.percentEncodedQuery?.contains("token=signed%2Bvalue") == true)
        #expect(parts.fragment == "page=2")
        #expect(WorkspaceMutationRevision.assetURL(url, revision: nil) == url)
    }
}
