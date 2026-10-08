import Foundation
import Testing
@testable import T3Code

@Suite("Chat Markdown details sections")
struct MarkdownDetailsParsingTests {
    private func details(_ block: MarkdownBlock?) -> MarkdownDetails? {
        guard case let .details(details) = block else { return nil }
        return details
    }

    @Test
    func parsesSummaryBodyAndWhatFollows() {
        let document = MarkdownDocument(parsing: """
        <details>
        <summary>Build output</summary>

        Body with **bold**

        - item

        </details>

        After
        """)

        #expect(document.blocks.count == 2)
        let section = details(document.blocks.first)
        #expect(section?.summary == "Build output")
        #expect(section?.isOpen == false)
        #expect(section?.terminated == true)
        #expect(section?.content.blocks == [
            .paragraph("Body with **bold**"),
            .unorderedList([MarkdownListItem(task: nil, blocks: [.paragraph("item")])]),
        ])
        #expect(document.blocks.last == .paragraph("After"))
    }

    @Test
    func openAttributeStartsExpanded() {
        #expect(details(MarkdownDocument(parsing: "<details open>\nx\n</details>").blocks.first)?.isOpen == true)
        #expect(details(MarkdownDocument(parsing: "<DETAILS class=\"a\" open=\"\">\nx\n</DETAILS>").blocks.first)?.isOpen == true)
        #expect(details(MarkdownDocument(parsing: "<details data-opened>\nx\n</details>").blocks.first)?.isOpen == false)
    }

    @Test
    func missingOrEmptySummaryHasNone() {
        #expect(details(MarkdownDocument(parsing: "<details>\nBody\n</details>").blocks.first)?.summary == nil)
        #expect(details(MarkdownDocument(parsing: "<details><summary> </summary>\nBody\n</details>").blocks.first)?.summary == nil)
    }

    @Test
    func singleLineSectionHandsTrailingTextBack() {
        let document = MarkdownDocument(parsing: "<details><summary>A</summary>Body</details> trailing")
        #expect(details(document.blocks.first)?.summary == "A")
        #expect(details(document.blocks.first)?.content.blocks == [.paragraph("Body")])
        #expect(document.blocks.last == .paragraph("trailing"))
    }

    @Test
    func nestedSectionsAndFencedTagsKeepTheirDepth() {
        let document = MarkdownDocument(parsing: """
        <details><summary>Outer</summary>

        <details>
        <summary>Inner</summary>

        ```html
        </details>
        ```

        </details>

        Outer tail
        </details>
        Done
        """)

        let outer = details(document.blocks.first)
        #expect(outer?.summary == "Outer")
        let inner = details(outer?.content.blocks.first)
        #expect(inner?.summary == "Inner")
        #expect(inner?.content.blocks == [.codeBlock(language: "html", code: "</details>")])
        #expect(outer?.content.blocks.last == .paragraph("Outer tail"))
        #expect(document.blocks.last == .paragraph("Done"))
    }

    @Test
    func unclosedSectionRunsToTheEndUnterminated() {
        let section = details(MarkdownDocument(parsing: "<details>\n<summary>Log</summary>\n\nline one").blocks.first)
        #expect(section?.terminated == false)
        #expect(section?.content.blocks == [.paragraph("line one")])
    }

    @Test
    func lookalikesStayText() {
        #expect(MarkdownDocument(parsing: "<detailsx>\nBody").blocks == [.paragraph("<detailsx>\nBody")])
        #expect(MarkdownDocument(parsing: "See <details> here").blocks == [.paragraph("See <details> here")])
        #expect(MarkdownDocument(parsing: "</details>").blocks == [.paragraph("</details>")])
    }

    @Test
    func summaryHTMLBecomesInlineMarkdown() {
        let section = details(MarkdownDocument(parsing: "<details><summary><b>Bold</b> &amp; <code>x</code></summary>\nBody\n</details>").blocks.first)
        #expect(section?.summary == "**Bold** & `x`")
    }

    @Test
    func renderedSectionsAreNumberedInDocumentOrder() {
        let cache = MarkdownRenderCache(documentCountLimit: 4, documentCostLimit: 64_000)
        let rendered = cache.documentImmediately(for: MarkdownContentRevision("""
        <details><summary>A</summary>

        <details><summary>B</summary>
        b
        </details>

        </details>

        <details>
        c
        </details>
        """))
        guard case let .details(first) = rendered?.blocks.first,
              case let .details(nested) = first.blocks.first,
              case let .details(last) = rendered?.blocks.last else {
            Issue.record("Expected sections")
            return
        }
        let ordinals: [Int] = [first.ordinal, nested.ordinal, last.ordinal]
        #expect(ordinals == [0, 1, 2])
        #expect(String(last.summary.attributedText.characters) == "Details")
    }

    @Test @MainActor
    func citationOffsetsCountTheSummaryAndBody() throws {
        let cache = MarkdownRenderCache(documentCountLimit: 4, documentCostLimit: 64_000)
        let document = try #require(cache.documentImmediately(for: MarkdownContentRevision(
            "Intro\n\n<details><summary>More</summary>\n\nHidden words\n</details>\n\nOutro"
        )))
        #expect(document.citationText == "Intro\nMore\nHidden words\nOutro")
        let range = (document.citationText as NSString).range(of: "words")
        let marked = MarkdownCitationHighlight.blocks(document.blocks, range: range)
        guard case let .details(section) = marked[1], case let .paragraph(body) = section.blocks.first else {
            Issue.record("Expected a section")
            return
        }
        let highlighted = body.attributedText.runs.filter { $0.backgroundColor != nil }
            .map { String(body.attributedText[$0.range].characters) }
        #expect(highlighted == ["words"])
    }
}

@Suite("Chat Markdown code fences")
struct MarkdownCodeFenceTests {
    @Test
    func titleComesFromAttributesOrAFileNameToken() {
        #expect(MarkdownCodeFenceInfo.title(meta: #"title="src/a.ts""#) == "src/a.ts")
        #expect(MarkdownCodeFenceInfo.title(meta: "filename=x.py") == "x.py")
        #expect(MarkdownCodeFenceInfo.title(meta: "file='my file.rb'") == "my file.rb")
        #expect(MarkdownCodeFenceInfo.title(meta: "{1,3} src/main.ts") == "src/main.ts")
        #expect(MarkdownCodeFenceInfo.title(meta: "{1,3}") == nil)
        #expect(MarkdownCodeFenceInfo.title(meta: "") == nil)
    }

    @Test
    func parserCarriesTitleAndTermination() {
        #expect(MarkdownDocument(parsing: "```ts title=\"x.ts\"\nlet a = 1\n```").blocks == [
            .codeBlock(language: "ts", code: "let a = 1", title: "x.ts"),
        ])
        #expect(MarkdownDocument(parsing: "```bash\necho").blocks == [
            .codeBlock(language: "bash", code: "echo", terminated: false),
        ])
    }

    /// The web client's "Run in terminal" cases, through the parser.
    @Test
    func onlyACompleteSingleLineShellBlockRuns() {
        func runnable(_ source: String, isStreaming: Bool = false) -> String? {
            var blocks = MarkdownDocument(parsing: source).blocks
            if case let .blockquote(quoted) = blocks.first { blocks = quoted.blocks }
            guard case let .codeBlock(language, code, _, terminated) = blocks.first else { return nil }
            return MarkdownShellCommand.runnable(language: language, code: code, terminated: terminated, isStreaming: isStreaming)
        }

        #expect(runnable("```bash\necho hello\n```") == "echo hello")
        #expect(runnable("```bash\necho hello\n```", isStreaming: true) == nil)
        for source in ["~~~bash\necho tilde\n~~~", "> ```bash\n> echo quote\n> ```", "````bash\necho four\n````", "```pwsh\nGet-Item .\n```"] {
            #expect(runnable(source) != nil, "\(source)")
        }
        for source in [
            "```bash\necho one\necho two\n```",
            "```typescript\necho hello\n```",
            "```Bash\necho hello\n```",
            "```bash\n\n```",
            "```bash\necho hello\n\n```",
            "```bash\necho hello\\\n```",
            "```bash\necho safe \u{202E}#\n```",
            "```bash\necho\ttab\n```",
            "```bash\necho incomplete",
            "````bash\necho incomplete\n```",
        ] {
            #expect(runnable(source) == nil, "\(source)")
        }
    }
}

@Suite("Chat Markdown skill chips")
@MainActor
struct MarkdownSkillChipTests {
    @Test
    func tokensFollowTheWebRules() {
        func names(_ text: String) -> [String] { MarkdownSkillChips.tokens(in: text).map(\.name) }
        #expect(names("$deploy") == ["deploy"])
        #expect(names("use $frontend-design and $ns:tool now") == ["frontend-design", "ns:tool"])
        #expect(names("costs $5, $10k or $1e6 and $12_000") == [])
        #expect(names("$123abc") == ["123abc"])
        #expect(names("a$deploy $deploy. ($deploy)") == [])
        let text = "run $deploy"
        let token = MarkdownSkillChips.tokens(in: text).first
        #expect(token.map { String(text[$0.range]) } == "$deploy")
    }

    @Test
    func displayNameMatchesTheWebFormatter() {
        #expect(MarkdownSkillChips.displayName(name: "frontend-design", displayName: nil) == "Frontend Design")
        #expect(MarkdownSkillChips.displayName(name: "a:b_c d", displayName: "  ") == "A B C D")
        #expect(MarkdownSkillChips.displayName(name: "x", displayName: " Pretty ") == "Pretty")
    }

    @Test
    func chipsReplaceKnownSkillsOutsideCodeAndLinks() {
        let catalog = MarkdownSkillCatalog([FeatureProviderSkill(name: "deploy", displayName: "Deploy App")])
        let text = MarkdownInlineFormatter.format("Use $deploy, not `$deploy` or [$deploy](https://example.com) or $other\nthen **$deploy**")
        let chipped = MarkdownSkillChips.apply(to: text, catalog: catalog)
        #expect(chipped.map { String($0.characters) }
            == "Use $deploy, not $deploy or $deploy or $other\nthen Deploy App")
        let spaced = MarkdownInlineFormatter.format("Use $deploy now")
        #expect(MarkdownSkillChips.apply(to: spaced, catalog: catalog).map { String($0.characters) } == "Use Deploy App now")
        #expect(MarkdownSkillChips.apply(to: MarkdownInlineFormatter.format("only $other"), catalog: catalog) == nil)
    }

    @Test
    func styledRunsAreReusedPerCatalog() {
        let catalog = MarkdownSkillCatalog([FeatureProviderSkill(name: "deploy")])
        let inline = MarkdownRenderedInline(attributedText: AttributedString("run $deploy"), style: .body)
        let blocks: [MarkdownRenderedBlock] = [.paragraph(inline)]
        let first = MarkdownSkillChips.blocks(blocks, catalog: catalog)
        #expect(first == MarkdownSkillChips.blocks(blocks, catalog: catalog))
        #expect(first != blocks)
        let plain = MarkdownRenderedInline(attributedText: AttributedString("no skills"), style: .body)
        #expect(MarkdownSkillChips.blocks([.paragraph(plain)], catalog: catalog) == [.paragraph(plain)])
    }
}

@Suite("Chat Markdown table export")
struct MarkdownTableExportTests {
    @Test
    func markdownKeepsAlignmentAndEscapesBarePipes() {
        let table = MarkdownTable(
            header: ["Name", "Code", "Total"],
            alignments: [.leading, .center, .trailing],
            rows: [["a \\| b", "`x|y`", "1"], ["**c**", "", "2"]]
        )
        #expect(MarkdownTableExport.markdown(table) == """
        | Name | Code | Total |
        | --- | :---: | ---: |
        | a \\| b | `x\\|y` | 1 |
        | **c** |  | 2 |
        """)
    }

    @Test
    func csvQuotesOnlyWhatNeedsIt() {
        #expect(MarkdownTableExport.csv(header: ["Name", "Note"], rows: [
            ["Ada,  L", "said \"hi\""],
            [" plain\ttext ", "multi\nline"],
        ]) == [
            "Name,Note",
            #""Ada, L","said ""hi""""#,
            "plain text,multi line",
        ].joined(separator: "\n"))
    }

    @Test
    func renderedTableExportsItsSourceAndVisibleText() {
        let cache = MarkdownRenderCache(documentCountLimit: 4, documentCostLimit: 64_000)
        let rendered = cache.documentImmediately(for: MarkdownContentRevision("| A | B |\n| :---: | --- |\n| **x** | `y,z` |"))
        guard case let .table(table) = rendered?.blocks.first else {
            Issue.record("Expected a table")
            return
        }
        #expect(table.markdownExport == "| A | B |\n| :---: | --- |\n| **x** | `y,z` |")
        #expect(table.csvExport == "A,B\nx,\"y,z\"")
    }
}
