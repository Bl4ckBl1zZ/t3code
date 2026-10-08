import Foundation
import Testing
@testable import T3Code

@Suite("User message context blocks")
struct UserMessageContentTests {
    @Test func plainTextIsUntouched() {
        let content = UserMessageContent.parse("Fix the build\n\nThanks")
        #expect(content.body == "Fix the build\n\nThanks")
        #expect(!content.hasContext)
    }

    @Test func splitsATrailingTerminalBlockIntoEntries() {
        let text = """
        Why does this fail? @terminal-1:2-3

        <terminal_context>
        - Terminal 1 lines 2-3:
          2 | error: boom
          3 |   at <main>

        - Server line 9:
          9 | listening
        </terminal_context>
        """
        let content = UserMessageContent.parse(text)
        #expect(content.body == "Why does this fail? @terminal-1:2-3")
        #expect(content.terminalContexts == [
            .init(header: "Terminal 1 lines 2-3", body: "2 | error: boom\n3 |   at <main>"),
            .init(header: "Server line 9", body: "9 | listening"),
        ])
    }

    @Test func stripsTheElementBlockBeforeTheTerminalBlock() {
        let text = """
        Make it blue

        <terminal_context>
        - Terminal 1 line 4:
          4 | ok
        </terminal_context>

        <element_context>
        - <Button> (App.tsx:12):
          url: http://localhost:5173/
          html:
            <button class="a"><span>Go</span></button>
        </element_context>
        """
        let content = UserMessageContent.parse(text)
        #expect(content.body == "Make it blue")
        #expect(content.terminalContexts.map(\.header) == ["Terminal 1 line 4"])
        #expect(content.elementContexts == [
            .init(header: "<Button> (App.tsx:12)", body: "url: http://localhost:5173/\nhtml:\n  <button class=\"a\"><span>Go</span></button>"),
        ])
    }

    @Test func aBlockInTheMiddleOrUnclosedStaysAsTyped() {
        let middle = "<terminal_context>\n- T line 1:\n  x\n</terminal_context>\nand then more"
        #expect(UserMessageContent.parse(middle).body == middle)
        #expect(UserMessageContent.parse(middle).terminalContexts.isEmpty)

        let unclosed = "Look\n\n<terminal_context>\n- T line 1:\n  x"
        #expect(UserMessageContent.parse(unclosed).body == unclosed)

        // Web matches the bare tag only; attributes are not a context block.
        let attributed = "Look\n<terminal_context id=\"1\">\n- T line 1:\n  x\n</terminal_context>"
        #expect(UserMessageContent.parse(attributed).body == attributed)
    }

    @Test func aMessageThatIsOnlyContextHasAnEmptyBody() {
        let content = UserMessageContent.parse("<terminal_context>\n- Terminal 1 line 1:\n  1 | $ ls\n</terminal_context>\n")
        #expect(content.body.isEmpty)
        #expect(content.terminalContexts.count == 1)
        #expect(!content.isLong)
    }

    @Test func linesBeforeTheFirstHeaderAndUnindentedLinesAreIgnored() {
        let content = UserMessageContent.parse("x\n<element_context>\nstray\n- <div>:\n  kept\nnot indented\n</element_context>")
        #expect(content.elementContexts == [.init(header: "<div>", body: "kept")])
    }

    @Test func parsesStackedPreviewAnnotationsInOrder() {
        let text = """
        Tighten the header

        <preview_annotation>
        Preview annotation:
        Id: a1
        Page: Dashboard
        Comment: Too much padding
        Targets: 1 selected element, 1 drawing.
        Requested visual changes:
        - padding: 24px → 12px
        - color: (unset) → red
        The attached screenshot is the annotated preview crop.
        <element_context>
        - <Header>:
          selector: header
        </element_context>
        </preview_annotation>

        <preview_annotation>
        Preview annotation:
        Id: a2
        Page: Settings
        </preview_annotation>
        """
        let content = UserMessageContent.parse(text)
        #expect(content.body == "Tighten the header")
        #expect(content.previewAnnotations.map(\.id) == ["a1", "a2"])
        let first = content.previewAnnotations[0]
        #expect(first.title == "Dashboard")
        #expect(first.comment == "Too much padding")
        #expect(first.targetSummary == "1 selected element, 1 drawing.")
        #expect(first.styleChanges == ["padding: 24px → 12px", "color: (unset) → red"])
        #expect(first.hasScreenshot)
        let second = content.previewAnnotations[1]
        #expect(second.comment.isEmpty)
        #expect(second.styleChanges.isEmpty)
        #expect(!second.hasScreenshot)
    }

    @Test func parsesAStrictReplyEnvelope() {
        let content = UserMessageContent.parse("[Replying to: \"Ship it?\"]\n\nYes, go ahead")
        #expect(content.reply == .init(referencedText: "Ship it?"))
        #expect(content.body == "Yes, go ahead")

        let own = UserMessageContent.parse("  [Replying to your previous message: \"a\nb\"]\nok")
        #expect(own.reply == .init(referencedText: "a\nb"))
        #expect(own.body == "ok")

        // Mentions and envelopes with nothing after them are ordinary text.
        #expect(UserMessageContent.parse("I was [Replying to: \"x\"] earlier").reply == nil)
        #expect(UserMessageContent.parse("[Replying to: \"x\"]").reply == nil)
        #expect(UserMessageContent.parse("[Replying to: \"\"]\nhi").reply == nil)
    }

    @Test func splitsTerminalHeaders() {
        let range = UserMessageContent.terminalHeaderParts("Terminal 1 lines 3-5")
        #expect(range?.name == "Terminal 1")
        #expect(range?.range == "lines 3–5")
        let single = UserMessageContent.terminalHeaderParts("dev server line 9")
        #expect(single?.name == "dev server")
        #expect(single?.range == "line 9")
        #expect(UserMessageContent.terminalHeaderParts("Terminal 1") == nil)
    }

    @Test func collapsesByRenderedLengthOrLineCount() {
        #expect(!UserMessageContent.shouldCollapse(String(repeating: "a", count: 600)))
        #expect(UserMessageContent.shouldCollapse(String(repeating: "a", count: 601)))
        #expect(!UserMessageContent.shouldCollapse(Array(repeating: "line", count: 8).joined(separator: "\n")))
        #expect(UserMessageContent.shouldCollapse(Array(repeating: "line", count: 9).joined(separator: "\n")))
        // A link counts by its label, not its URL.
        let link = "[docs](https://example.com/\(String(repeating: "x", count: 700)))"
        #expect(!UserMessageContent.shouldCollapse(link))
        #expect(!UserMessageContent.shouldCollapse("   \n\n  "))
    }

    @Test func previewDropsContextIncludingABlockTheServerTruncated() {
        #expect(UserMessageContent.previewText("Fix it\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>") == "Fix it")
        // The shell caps text at 512 characters, which can cut the closing tag.
        #expect(UserMessageContent.previewText("Fix it\n\n<terminal_context>\n- Terminal 1 lines 1-90:\n  1 | lo") == "Fix it")
        #expect(UserMessageContent.previewText("<terminal_context>\n- Terminal 1 lines 1-2:\n  1 | x\n</terminal_context>") == "Terminal 1 lines 1-2")
        #expect(UserMessageContent.previewText("[Replying to: \"q\"]\nanswer") == "answer")
    }

    @Test func pairsAnnotationCropsAndKeepsStrayOnesAsAttachments() {
        func attachment(_ name: String, _ mime: String = "image/png") -> FeatureMessageAttachment {
            FeatureMessageAttachment(id: name, name: name, mimeType: mime, sizeBytes: 1)
        }
        let layout = UserMessageAttachmentLayout(
            attachments: [attachment("photo.png"), attachment("preview-annotation-a1.png"), attachment("preview-annotation-a2.png"), attachment("preview-annotation-notes.txt", "text/plain")],
            annotationCount: 1
        )
        #expect(layout.annotationImages.map(\.id) == ["preview-annotation-a1.png"])
        #expect(layout.regular.map(\.id) == ["photo.png", "preview-annotation-a2.png", "preview-annotation-notes.txt"])
    }
}
