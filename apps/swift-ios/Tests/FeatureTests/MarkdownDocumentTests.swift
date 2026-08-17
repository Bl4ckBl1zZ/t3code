import Foundation
import Testing
@testable import T3Code

@Suite("Chat Markdown")
struct MarkdownDocumentTests {
    @Test
    func separatesHeadingsParagraphsAndListKinds() {
        let document = MarkdownDocument(
            parsing: """
            # Release notes

            Includes **important** details.

            - First
            - [x] Shipped
            - [ ] Follow up

            3. Third
            4. Fourth
            """
        )

        #expect(
            document.blocks == [
                .heading(level: 1, text: "Release notes"),
                .paragraph("Includes **important** details."),
                .unorderedList([
                    MarkdownListItem(task: nil, blocks: [.paragraph("First")]),
                    MarkdownListItem(task: .complete, blocks: [.paragraph("Shipped")]),
                    MarkdownListItem(task: .incomplete, blocks: [.paragraph("Follow up")]),
                ]),
                .orderedList(
                    start: 3,
                    items: [
                        MarkdownListItem(task: nil, blocks: [.paragraph("Third")]),
                        MarkdownListItem(task: nil, blocks: [.paragraph("Fourth")]),
                    ]
                ),
            ]
        )
    }

    @Test
    func preservesNestedStructureInsideQuotesAndLists() {
        let document = MarkdownDocument(
            parsing: """
            > ## Heads up
            > Read this first.
            >
            > - Quoted item

            - Parent
              - Nested child
            """
        )

        guard case let .blockquote(quote) = document.blocks.first else {
            Issue.record("Expected a block quote")
            return
        }
        #expect(
            quote.blocks == [
                .heading(level: 2, text: "Heads up"),
                .paragraph("Read this first."),
                .unorderedList([
                    MarkdownListItem(task: nil, blocks: [.paragraph("Quoted item")]),
                ]),
            ]
        )

        guard case let .unorderedList(items) = document.blocks.last else {
            Issue.record("Expected an unordered list")
            return
        }
        #expect(
            items == [
                MarkdownListItem(
                    task: nil,
                    blocks: [
                        .paragraph("Parent"),
                        .unorderedList([
                            MarkdownListItem(task: nil, blocks: [.paragraph("Nested child")]),
                        ]),
                    ]
                ),
            ]
        )
    }

    @Test
    func parsesGithubAlertBlockquotes() {
        let document = MarkdownDocument(
            parsing: """
            > [!WARNING]
            > Body text
            """
        )

        guard case let .githubAlert(kind, content) = document.blocks.first else {
            Issue.record("Expected a GitHub alert")
            return
        }
        #expect(kind == .warning)
        #expect(content.blocks == [.paragraph("Body text")])
    }

    @Test
    func matchesAlertMarkersCaseInsensitively() {
        let document = MarkdownDocument(
            parsing: """
            > [!note]
            > Lowercase marker
            """
        )

        guard case let .githubAlert(kind, content) = document.blocks.first else {
            Issue.record("Expected a GitHub alert")
            return
        }
        #expect(kind == .note)
        #expect(content.blocks == [.paragraph("Lowercase marker")])
    }

    @Test
    func keepsQuotesWithInlineMarkerTextAsPlainBlockquotes() {
        let document = MarkdownDocument(parsing: "> [!NOTE] inline text")

        guard case let .blockquote(quote) = document.blocks.first else {
            Issue.record("Expected a block quote")
            return
        }
        #expect(quote.blocks == [.paragraph("[!NOTE] inline text")])
    }

    @Test
    func leavesPlainBlockquotesUnaffectedByAlertParsing() {
        let document = MarkdownDocument(parsing: "> Just a quote")

        guard case let .blockquote(quote) = document.blocks.first else {
            Issue.record("Expected a block quote")
            return
        }
        #expect(quote.blocks == [.paragraph("Just a quote")])
    }

    @Test
    func parsesTablesWithAlignmentEscapesAndNormalizedRows() {
        let document = MarkdownDocument(
            parsing: """
            | Name | Status | Notes |
            | :--- | :---: | ---: |
            | Parser | Ready | **Fast** |
            | Escaped \\| pipe | ``a|b`` | [Docs](https://example.com) |
            | Short | Row |
            | Extra | cells | stay | ignored |
            """
        )

        #expect(
            document.blocks == [
                .table(
                    MarkdownTable(
                        header: ["Name", "Status", "Notes"],
                        alignments: [.leading, .center, .trailing],
                        rows: [
                            ["Parser", "Ready", "**Fast**"],
                            ["Escaped \\| pipe", "``a|b``", "[Docs](https://example.com)"],
                            ["Short", "Row", ""],
                            ["Extra", "cells", "stay"],
                        ]
                    )
                ),
            ]
        )
    }

    @Test
    func rejectsTableDelimiterCellsWithFewerThanThreeDashes() {
        let document = MarkdownDocument(
            parsing: """
            Name | Status
            -- | ---
            Parser | Ready
            """
        )

        #expect(
            document.blocks == [
                .paragraph("Name | Status\n-- | ---\nParser | Ready"),
            ]
        )
    }

    @Test
    func rendersTableCellsThroughTheInlineMarkdownCache() throws {
        let source = """
        Label | Value
        --- | ---
        **Build** | `green`
        """
        let revision = MarkdownContentRevision(source)
        let rendered = try #require(
            MarkdownRenderCache.shared.documentImmediately(for: revision)
        )
        guard case let .table(table) = rendered.blocks.first else {
            Issue.record("Expected a rendered table")
            return
        }

        #expect(String(table.header[0].attributedText.characters) == "Label")
        #expect(String(table.rows[0][0].attributedText.characters) == "Build")
        #expect(
            table.rows[0][0].attributedText.runs.contains {
                $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
            }
        )
        #expect(
            table.rows[0][1].attributedText.runs.contains {
                $0.inlinePresentationIntent?.contains(.code) == true
            }
        )
    }

    @Test
    func fencedCodeKeepsLanguageAndContentsLiteral() {
        let document = MarkdownDocument(
            parsing: """
            ```swift
            let value = "**not emphasis**"
              print(value)
            ```
            """
        )

        #expect(
            document.blocks == [
                .codeBlock(
                    language: "swift",
                    code: "let value = \"**not emphasis**\"\n  print(value)"
                ),
            ]
        )
    }

    @Test
    func unclosedFenceConsumesTheRemainingMessage() {
        let document = MarkdownDocument(
            parsing: """
            ~~~console
            pnpm test
            no closing fence
            """
        )

        #expect(
            document.blocks == [
                .codeBlock(language: "console", code: "pnpm test\nno closing fence"),
            ]
        )
    }

    @Test
    func plaintextCodeBlocksWrapByDefault() {
        for language in ["text", "TEXT", "txt", "plaintext", "plain", "md", "markdown"] {
            #expect(MarkdownCodeBlockWrapping.wrapsByDefault(language: language))
        }

        for language in [nil, "swift", "typescript", "console"] {
            #expect(!MarkdownCodeBlockWrapping.wrapsByDefault(language: language))
        }
    }

    /// The shape agents actually emit: a sentence, then media on its own lines.
    /// Before these became blocks the renderer kept only the alt text, so a
    /// message of three pictures read as three stray captions.
    @Test
    func liftsStandaloneImagesOutOfTheirParagraph() {
        let document = MarkdownDocument(
            parsing: """
            Of course!
            ![A happy dog](https://example.com/dog.png)
            ![A cute puppy](./out/puppy.jpeg "Puppy")

            ![](<spaced name.png>) ![Second](/tmp/browser-artifacts/shot.png)
            """
        )

        #expect(
            document.blocks == [
                .paragraph("Of course!"),
                .image(
                    MarkdownInlineImage(
                        alt: "A happy dog",
                        src: "https://example.com/dog.png"
                    )
                ),
                .image(MarkdownInlineImage(alt: "A cute puppy", src: "./out/puppy.jpeg")),
                .image(MarkdownInlineImage(alt: "", src: "spaced name.png")),
                .image(
                    MarkdownInlineImage(
                        alt: "Second",
                        src: "/tmp/browser-artifacts/shot.png"
                    )
                ),
            ]
        )
    }

    /// An image sharing its line with text cannot become a block without losing
    /// the text, so the line stays a paragraph and the image keeps rendering as
    /// its alt text — which is all Foundation's inline parser can express.
    @Test
    func keepsImagesThatShareALineInsideTheirParagraph() {
        for source in [
            "Here you go: ![A dog](dog.png)",
            "![A dog](dog.png) is the one",
            "[![A dog](dog.png)](https://example.com)",
            "![Unclosed](dog.png",
            "![Reference][dog]",
        ] {
            #expect(MarkdownDocument(parsing: source).blocks == [.paragraph(source)], "\(source)")
        }
    }

    /// A screenshot path from a Windows host arrives with a drive letter, and
    /// capture tools number repeats with `(1)`. Both have to survive the
    /// destination scan, which otherwise ends at the first paren.
    @Test
    func keepsBalancedParensInsideAnImageDestination() {
        #expect(
            MarkdownDocument(parsing: "![Shot](/C:/shots/out(1).png)").blocks == [
                .image(MarkdownInlineImage(alt: "Shot", src: "/C:/shots/out(1).png")),
            ]
        )
    }

    @Test
    func imagesInListItemsAndQuotesBecomeBlocksToo() {
        let document = MarkdownDocument(
            parsing: """
            - ![In a list](a.png)

            > ![In a quote](b.png)
            """
        )

        #expect(
            document.blocks == [
                .unorderedList([
                    MarkdownListItem(
                        task: nil,
                        blocks: [.image(MarkdownInlineImage(alt: "In a list", src: "a.png"))]
                    ),
                ]),
                .blockquote(
                    MarkdownDocument(
                        parsing: "![In a quote](b.png)"
                    )
                ),
            ]
        )
    }

    @Test
    func parsesSetextHeadingsAndNormalizesWindowsNewlines() {
        let document = MarkdownDocument(parsing: "Heading\r\n=======\r\n\r\nBody")

        #expect(
            document.blocks == [
                .heading(level: 1, text: "Heading"),
                .paragraph("Body"),
            ]
        )
    }

    @Test
    func inlineFormatterRetainsEmphasisCodeAndLinks() {
        let formatted = MarkdownInlineFormatter.format(
            "Use **bold**, *emphasis*, `code`, and [docs](https://example.com)."
        )
        let runs = Array(formatted.runs)

        #expect(String(formatted.characters) == "Use bold, emphasis, code, and docs.")
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        #expect(runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        #expect(runs.contains { $0.link == URL(string: "https://example.com") })
    }

    /// Foundation's Markdown parser resolves HTML entities on its own, so this
    /// app must never decode them a second time: another pass would turn an
    /// author's escaped `&amp;#128512;` into the emoji they escaped, and would
    /// let `&#42;` reach the parser as emphasis syntax. Entities inside code
    /// spans stay verbatim.
    @Test
    func inlineFormatterResolvesHtmlEntitiesOnceAndKeepsCodeSpansRaw() {
        #expect(
            String(MarkdownInlineFormatter.format("Escape it as &amp; here").characters)
                == "Escape it as & here"
        )
        #expect(
            String(MarkdownInlineFormatter.format("Ship it &#128512; today").characters)
                == "Ship it 😀 today"
        )
        #expect(
            String(MarkdownInlineFormatter.format("Hex &#x1f680; rocket").characters)
                == "Hex 🚀 rocket"
        )
        #expect(
            String(MarkdownInlineFormatter.format("Double &amp;#128512; stays escaped").characters)
                == "Double &#128512; stays escaped"
        )
        #expect(
            String(MarkdownInlineFormatter.format("Star &#42; is literal").characters)
                == "Star * is literal"
        )

        let codeSpan = MarkdownInlineFormatter.format("Code span `&amp;` stays raw")

        #expect(String(codeSpan.characters) == "Code span &amp; stays raw")
        #expect(codeSpan.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    }

    /// Out-of-range numeric entities are malformed input rather than a crash:
    /// Swift's failable `Unicode.Scalar` gives the parser nothing to trap on,
    /// so no equivalent of the Expo client's code-point guard is needed. The
    /// exact fallback glyph is Foundation's business; only surviving is ours.
    @Test
    func inlineFormatterSurvivesOutOfRangeNumericEntities() {
        #expect(
            String(MarkdownInlineFormatter.format("Bad &#9999999999; value").characters)
                == "Bad &#9999999999; value"
        )
        #expect(
            !String(MarkdownInlineFormatter.format("Bad &#x110000; value").characters).isEmpty
        )
    }
}
