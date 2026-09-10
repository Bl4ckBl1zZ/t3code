import Testing
@testable import T3Code

struct ThreadHistoricalWorkSummaryTests {
    @Test func mixedCommandsAndFileEditsCountUniquePaths() {
        #expect(ThreadHistoricalWorkSummary.label([
            .init(action: .command), .init(action: .edit, files: ["a.swift", "b.swift"]), .init(action: .edit, files: ["a.swift"])
        ]) == "Ran 1 command and changed 2 files")
    }
    @Test func searchesAndOtherToolsUseDistinctLabels() {
        #expect(ThreadHistoricalWorkSummary.label([.init(action: .codeSearch), .init(action: .webSearch), .init(action: .tool)]) == "Searched code 1 time, searched the web 1 time, and used 1 tool")
    }
    @Test func singleCallsAndEmptyGroupsHaveNoSummary() {
        #expect(ThreadHistoricalWorkSummary.label([]) == nil)
        #expect(ThreadHistoricalWorkSummary.label([.init(action: .read)]) == nil)
    }
    @Test func errorsRunningCallsAndPersistentResourcesStayVisible() {
        for item in [ThreadHistoricalWorkItem(action: .tool, successful: false), .init(action: .command, running: true), .init(action: .tool, persistent: true)] {
            #expect(ThreadHistoricalWorkSummary.label([.init(action: .read), item]) == nil)
        }
    }
    @Test func editsWithoutPathsStillCount() {
        #expect(ThreadHistoricalWorkSummary.label([.init(action: .edit), .init(action: .edit, files: ["a.swift"]), .init(action: .edit, files: ["a.swift"])]) == "Changed 2 files")
    }
    @Test func pluralReadsAndCommandsKeepEncounterOrder() {
        #expect(ThreadHistoricalWorkSummary.label([.init(action: .read), .init(action: .read), .init(action: .command), .init(action: .command)]) == "Read 2 files and ran 2 commands")
    }
}
