import XCTest

@testable import T3Code

/// Ports apps/mobile/src/lib/composerAttachmentKinds.test.ts. Classification is
/// what keeps a PDF out of the image view, where it would spin on a decode that
/// never finishes, so the boundaries are asserted rather than assumed.
final class ComposerAttachmentKindsTests: XCTestCase {
    func testDocumentKindSplitsKindsTheWayTheAttachmentContractDoes() {
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "application/pdf"), .pdf)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "APPLICATION/PDF"), .pdf)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "video/mp4"), .video)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "video/quicktime"), .video)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "text/csv"), .file)
        XCTAssertEqual(
            ComposerAttachments.documentKind(mimeType: "application/octet-stream"),
            .file
        )
    }

    func testDocumentKindDoesNotMistakeAPDFIshNameForAPDF() {
        // The contract keys off MIME, so a mislabelled name stays a generic file.
        XCTAssertEqual(
            ComposerAttachments.documentKind(mimeType: "text/plain", name: "itinerary.pdf"),
            .file
        )
    }

    func testDocumentKindNeverReturnsImageSoAnImageNeverEntersTheDocumentPath() {
        // The shared classifier reports `.image` for image MIME types; the
        // document path has no preview URI, so those belong to the image path.
        XCTAssertEqual(ComposerAttachments.classify(mimeType: "image/png", name: "shot.png"), .image)
        XCTAssertEqual(
            ComposerAttachments.documentKind(mimeType: "image/png", name: "shot.png"),
            .file
        )
    }

    func testDocumentKindFallsBackToTheFileNameWhenThePickerGivesNoMIMEType() {
        // Android content:// URIs do this constantly.
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "", name: "itinerary.pdf"), .pdf)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "   ", name: "clip.MOV"), .video)
        XCTAssertEqual(ComposerAttachments.documentKind(mimeType: "", name: "blob"), .file)
        XCTAssertEqual(ComposerAttachments.classify(mimeType: "", name: "shot.PNG"), .image)
    }

    func testAPaddedMIMETypeFallsThroughToAGenericFile() {
        // The shared classifier trims only to decide whether a MIME type was
        // supplied at all, so padding survives into the comparisons and nothing
        // matches. Pinned so a well-meaning trim here cannot diverge from web.
        XCTAssertEqual(ComposerAttachments.classify(mimeType: "  application/pdf  "), .file)
    }

    func testOnlyImagesGetTheTighterByteCap() {
        XCTAssertEqual(ComposerAttachments.maximumBytes(for: .image), 10 * 1024 * 1024)
        for kind in [ComposerAttachmentKind.pdf, .video, .file] {
            XCTAssertEqual(
                ComposerAttachments.maximumBytes(for: kind),
                20 * 1024 * 1024,
                "\(kind.rawValue) should share the file cap"
            )
        }
    }

    func testUploadAttachmentsDropTheDraftIDAndKeepTheWireFields() {
        let uploads = ComposerAttachments.uploadAttachments([
            .document(
                DraftComposerDocumentAttachment(
                    id: "draft-1",
                    kind: .pdf,
                    name: "itinerary.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 1024,
                    dataUrl: "data:application/pdf;base64,AAAA"
                )
            ),
        ])

        XCTAssertEqual(
            uploads,
            [
                UploadChatAttachment(
                    type: .pdf,
                    name: "itinerary.pdf",
                    mimeType: "application/pdf",
                    sizeBytes: 1024,
                    dataUrl: "data:application/pdf;base64,AAAA"
                ),
            ]
        )
    }

    func testUploadAttachmentsDropTheImagePreviewURI() {
        let draft = DraftComposerAttachment.image(
            DraftComposerImageAttachment(
                id: "draft-2",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 12,
                dataUrl: "data:image/png;base64,AAAA",
                previewURI: "file:///tmp/shot.png"
            )
        )

        XCTAssertEqual(draft.kind, .image)
        XCTAssertEqual(draft.image?.previewURI, "file:///tmp/shot.png")
        XCTAssertEqual(
            ComposerAttachments.uploadAttachments([draft]),
            [
                UploadChatAttachment(
                    type: .image,
                    name: "shot.png",
                    mimeType: "image/png",
                    sizeBytes: 12,
                    dataUrl: "data:image/png;base64,AAAA"
                ),
            ]
        )
    }

    func testOnlyTheImageBranchExposesAThumbnailSource() {
        let document = DraftComposerAttachment.document(
            DraftComposerDocumentAttachment(
                id: "draft-3",
                kind: .video,
                name: "demo.mp4",
                mimeType: "video/mp4",
                sizeBytes: 2048,
                dataUrl: "data:video/mp4;base64,AAAA"
            )
        )

        XCTAssertNil(document.image)
        XCTAssertEqual(document.kind, .video)
        XCTAssertEqual(document.id, "draft-3")
    }
}
