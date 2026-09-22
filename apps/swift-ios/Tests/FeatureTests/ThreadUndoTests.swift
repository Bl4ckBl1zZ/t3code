import Testing
@testable import T3Code

@MainActor
@Suite("Thread undo")
struct ThreadUndoTests {
    @Test
    func consecutiveActionsOfOneKindUndoTogetherAndLeaveTheEarlierGroup() async {
        let center = ThreadUndoCenter()
        var undone: [String] = []
        for id in ["a", "b", "c"] {
            let kind: ThreadUndoCenter.Kind = id == "a" ? .archive : .settle
            let claim = center.begin(kind, threadID: id)
            center.offer(claim, action: id == "a" ? .archived : .settled) { undone.append(id) }
        }
        #expect(center.notice?.title == "Settled 2 threads")

        await center.undoLatest()
        #expect(undone == ["c", "b"])
        #expect(center.notice == .init(action: .archived, count: 1))
    }

    @Test
    func aReverseActionRetiresTheUndoEvenWhileItIsInFlight() async {
        let center = ThreadUndoCenter()
        var undone = false
        let claim = center.begin(.settle, threadID: "a")
        // Reopened before the settle landed.
        center.invalidate(.settle, threadID: "a")
        center.offer(claim, action: .settled) { undone = true }
        #expect(center.notice == nil)

        let next = center.begin(.settle, threadID: "a")
        center.offer(next, action: .settled) { undone = true }
        center.invalidate(.settle, threadID: "a")
        #expect(center.notice == nil)
        #expect(await center.undoLatest() == false)
        #expect(!undone)
    }

    @Test
    func expiryEndsEveryPendingUndo() async {
        let center = ThreadUndoCenter()
        var undone = false
        let claim = center.begin(.pin, threadID: "a")
        center.offer(claim, action: .unpinned) { undone = true }

        center.expireAll()
        #expect(center.notice == nil)
        #expect(await center.undoLatest() == false)
        #expect(!undone)
    }
}
