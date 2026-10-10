import XCTest

@testable import T3Code

/// Ports client-runtime's `childThreadInputsAtom` cases (upstream ed4ea1083d).
final class ChildThreadInputsTests: XCTestCase {
    private func thread(
        _ id: String,
        parent: String? = nil,
        relationship: String? = "subagent",
        state: FeatureThreadState = .idle,
        creationSource: String? = "mcp"
    ) -> FeatureThread {
        FeatureThread(
            id: id,
            projectID: "project",
            title: "Title \(id)",
            state: state,
            relationshipToParent: parent == nil ? nil : relationship,
            parentThreadID: parent,
            creationSource: creationSource
        )
    }

    private func waiting(_ threads: [FeatureThread], under id: String = "root") -> [String] {
        ChildThreadInputs.waiting(under: id, in: threads).map(\.id)
    }

    func testFindsQuestionsOnSubagentDescendantsInBreadthOrder() {
        let threads = [
            thread("root"),
            thread("child", parent: "root"),
            thread("grandchild", parent: "child", state: .waitingForInput),
            thread("asking", parent: "root", state: .waitingForInput),
            thread("other", parent: "elsewhere", state: .waitingForInput),
        ]
        XCTAssertEqual(waiting(threads), ["asking", "grandchild"])
        XCTAssertEqual(waiting(threads, under: "child"), ["grandchild"])
    }

    func testSkipsApprovalsForksAndProviderNativeSubagents() {
        let threads = [
            thread("root"),
            thread("approval", parent: "root", state: .waitingForApproval),
            thread("fork", parent: "root", relationship: "fork", state: .waitingForInput),
            thread("native", parent: "root", state: .waitingForInput, creationSource: "provider"),
        ]
        XCTAssertEqual(waiting(threads), [])
    }

    func testACycleInLineageEnds() {
        let threads = [
            thread("root", parent: "loop"),
            thread("loop", parent: "root", state: .waitingForInput),
        ]
        XCTAssertEqual(waiting(threads), ["loop"])
    }

    func testTitleCountsSubagents() {
        XCTAssertEqual(ChildThreadInputs.title(count: 1), "Subagent needs input")
        XCTAssertEqual(ChildThreadInputs.title(count: 3), "3 subagents need input")
    }
}
