import Foundation
import Testing
@testable import T3Code

/// Mirrors `packages/shared/src/threadLinks.test.ts`.
struct ThreadLinksTests {
    @Test func takesTheThreadIDVerbatimPercentEscapesIncluded() {
        #expect(ThreadLinks.threadID(href: "t3-thread://v1/mcp:1234") == "mcp:1234")
        #expect(ThreadLinks.threadID(href: "t3-thread://v1/thread:delegated-task:mcp%3A1") == "thread:delegated-task:mcp%3A1")
    }

    @Test func rejectsOtherLinksAndAnEmptyID() {
        #expect(ThreadLinks.threadID(href: "https://t3.codes") == nil)
        #expect(ThreadLinks.threadID(href: "t3-thread://v1/") == nil)
        #expect(ThreadLinks.threadID(href: "t3-thread://v1/ ") == nil)
    }

    @Test func resolvesAPercentEncodedIDWhenTheWrittenIDNamesNoThread() {
        let titles = ["thread:project:1": "Decoded", "provider%3A1": "Literal escape"]
        #expect(
            ThreadLinks.relabel("[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)") { titles[$0] }
                == "[Decoded](t3-thread://v1/thread:project:1) [Literal escape](t3-thread://v1/provider%3A1)"
        )
        // A thread with an empty title still exists, so its link is not redirected.
        let untitled = ["a%3A1": "", "a:1": "Other"]
        #expect(ThreadLinks.relabel("[Kept](t3-thread://v1/a%3A1)") { untitled[$0] } == "[Kept](t3-thread://v1/a%3A1)")
    }

    @Test func leavesLinksInsideCodeSpansAndFencesAsWritten() {
        let markdown = [
            "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
            "```md",
            "[old](t3-thread://v1/t1)",
            "```",
            "After [old](t3-thread://v1/t1)",
        ].joined(separator: "\n")
        #expect(
            ThreadLinks.relabel(markdown) { _ in "New" } == [
                "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
                "```md",
                "[old](t3-thread://v1/t1)",
                "```",
                "After [New](t3-thread://v1/t1)",
            ].joined(separator: "\n")
        )
    }

    @Test func formatsALabelThatWouldOtherwiseBreakTheLink() {
        #expect(ThreadLinks.format(threadID: "t1", label: "Fix [ci] \\ build") == "[Fix ci build](t3-thread://v1/t1)")
        #expect(ThreadLinks.format(threadID: "t1", label: " ] ") == "[t1](t3-thread://v1/t1)")
    }

    @Test func relabelsWithTheCurrentTitleAndLeavesUnknownThreadsAlone() {
        let titles = ["renamed": "Fix [the] build\nnow"]
        #expect(
            ThreadLinks.relabel("See [Old name](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).") { titles[$0] }
                == "See [Fix the build now](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted)."
        )
    }

    @Test func resolverMatchesWireIDsInTheMessagesEnvironmentOnly() {
        let here = FeatureThread(
            id: FeatureScopedID.thread(environmentID: "env-a", wireID: "t1"),
            wireID: "t1", projectID: "p", environmentID: "env-a", title: "Here"
        )
        let elsewhere = FeatureThread(
            id: FeatureScopedID.thread(environmentID: "env-b", wireID: "t2"),
            wireID: "t2", projectID: "p", environmentID: "env-b", title: "Elsewhere"
        )
        let resolver = ThreadLinkResolver(threads: [here, elsewhere], environmentID: "env-a")
        #expect(resolver.relabel("[x](t3-thread://v1/t1) [y](t3-thread://v1/t2)") == "[Here](t3-thread://v1/t1) [y](t3-thread://v1/t2)")
        #expect(resolver.openID(forLinkID: "t1") == here.id)
        #expect(resolver.openID(forLinkID: "t2") == FeatureScopedID.thread(environmentID: "env-a", wireID: "t2"))
    }
}
