import Foundation
import XCTest

@testable import T3Code

/// Ports the validation half of apps/mobile/src/lib/composerDocuments.ts.
///
/// A document rejected here is a picker error the user can act on; the same
/// document accepted here and rejected by the server is a failed turn, so the
/// caps have to match the contract exactly.
final class ComposerDocumentAttachmentTests: XCTestCase {
    func testAPickedDocumentKeepsItsNameAndTypeWithoutReEncoding() throws {
        let bytes = Data("%PDF-1.7 itinerary".utf8)

        let attachment = try FeatureDocumentProcessor.attachment(
            from: bytes,
            url: URL(fileURLWithPath: "/tmp/pick/Itinerary.pdf")
        )

        XCTAssertEqual(attachment.filename, "Itinerary.pdf")
        XCTAssertEqual(attachment.mimeType, "application/pdf")
        // Re-encoding a PDF the way images are re-encoded would corrupt it.
        XCTAssertEqual(attachment.data, bytes)
        XCTAssertNil(attachment.thumbnailData)
        XCTAssertEqual(
            ComposerAttachments.classify(
                mimeType: attachment.mimeType,
                name: attachment.filename
            ),
            .pdf
        )
    }

    func testVideoAndGenericFilesClassifyOffTheResolvedType() throws {
        let video = try FeatureDocumentProcessor.attachment(
            from: Data([0, 1, 2, 3]),
            url: URL(fileURLWithPath: "/tmp/pick/demo.mov")
        )
        XCTAssertEqual(video.mimeType, "video/quicktime")
        XCTAssertEqual(
            ComposerAttachments.classify(mimeType: video.mimeType, name: video.filename),
            .video
        )

        let generic = try FeatureDocumentProcessor.attachment(
            from: Data([0, 1, 2, 3]),
            url: URL(fileURLWithPath: "/tmp/pick/notes.csv")
        )
        XCTAssertEqual(
            ComposerAttachments.classify(mimeType: generic.mimeType, name: generic.filename),
            .file
        )
    }

    /// An extensionless blob is what a share sheet or a cloud provider hands
    /// back. It still has to attach, as a generic file.
    func testAnUnknownExtensionFallsBackToAGenericBinaryType() throws {
        let attachment = try FeatureDocumentProcessor.attachment(
            from: Data([9]),
            url: URL(fileURLWithPath: "/tmp/pick/blob")
        )

        XCTAssertEqual(attachment.mimeType, "application/octet-stream")
        XCTAssertEqual(
            ComposerAttachments.classify(
                mimeType: attachment.mimeType,
                name: attachment.filename
            ),
            .file
        )
    }

    func testDocumentsGetTheLooserTwentyMegabyteCap() throws {
        let justUnder = Data(count: ComposerAttachments.maximumFileBytes)
        XCTAssertNoThrow(
            try FeatureDocumentProcessor.attachment(
                from: justUnder,
                url: URL(fileURLWithPath: "/tmp/pick/big.pdf")
            )
        )

        let justOver = Data(count: ComposerAttachments.maximumFileBytes + 1)
        XCTAssertThrowsError(
            try FeatureDocumentProcessor.attachment(
                from: justOver,
                url: URL(fileURLWithPath: "/tmp/pick/big.pdf")
            )
        ) { error in
            XCTAssertEqual(
                error as? FeatureDocumentAttachmentError,
                .tooLarge(name: "big.pdf", maximumBytes: 20 * 1024 * 1024)
            )
        }
    }

    /// Images keep the tighter cap even when they arrive through the document
    /// browser, because the wire branch they land on is still the image one.
    func testAnImagePickedFromFilesKeepsTheTenMegabyteCap() {
        let overImageCap = Data(count: ComposerAttachments.maximumImageBytes + 1)

        XCTAssertThrowsError(
            try FeatureDocumentProcessor.attachment(
                from: overImageCap,
                url: URL(fileURLWithPath: "/tmp/pick/shot.png")
            )
        ) { error in
            XCTAssertEqual(
                error as? FeatureDocumentAttachmentError,
                .tooLarge(name: "shot.png", maximumBytes: 10 * 1024 * 1024)
            )
        }
    }

    func testAnEmptyFileIsRejectedBeforeItReachesTheWire() {
        XCTAssertThrowsError(
            try FeatureDocumentProcessor.attachment(
                from: Data(),
                url: URL(fileURLWithPath: "/tmp/pick/empty.txt")
            )
        ) { error in
            XCTAssertEqual(error as? FeatureDocumentAttachmentError, .empty(name: "empty.txt"))
        }
    }

    /// The glyph is the only thing that tells a PDF from a video in the strip,
    /// and routing either through the image path is what produced the spinner
    /// that never resolved.
    func testEachKindGetsItsOwnGlyph() {
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "image/png"), "photo")
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "application/pdf"), "doc.richtext")
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "video/mp4"), "film")
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "audio/mpeg"), "waveform")
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "application/zip"), "doc.zipper")
        XCTAssertEqual(FeatureAttachmentGlyph.systemImage(mimeType: "text/csv"), "doc")
        XCTAssertEqual(
            FeatureAttachmentGlyph.systemImage(mimeType: "", name: "itinerary.pdf"),
            "doc.richtext"
        )
    }

    /// Only image attachments need a vision-capable model; a PDF is read off
    /// disk by the agent, so refusing to send it on a text-only model would be
    /// wrong.
    func testDocumentsSendOnAModelThatRefusesImages() {
        let state = FeatureAttachmentPreparationState()

        XCTAssertTrue(
            FeatureComposerSubmissionEligibility.canSend(
                text: "",
                attachmentCount: 1,
                imagesAllowed: false,
                isSending: false,
                preparationState: state,
                imageAttachmentCount: 0
            )
        )
        XCTAssertFalse(
            FeatureComposerSubmissionEligibility.canSend(
                text: "",
                attachmentCount: 2,
                imagesAllowed: false,
                isSending: false,
                preparationState: state,
                imageAttachmentCount: 1
            )
        )
    }

    /// The wire branch the composer's draft attachments land on. Flattening a
    /// PDF onto the image branch is what the server rejected at turn time.
    func testTheUploadShapeKeepsTheClassifiedKind() throws {
        let pdf = try UploadChatAttachment(
            data: Data("%PDF".utf8),
            name: "itinerary.pdf",
            mimeType: "application/pdf",
            kind: ComposerAttachments.classify(
                mimeType: "application/pdf",
                name: "itinerary.pdf"
            )
        )

        XCTAssertEqual(pdf.type, .pdf)
        XCTAssertEqual(pdf.sizeBytes, 4)
        XCTAssertTrue(pdf.dataUrl.hasPrefix("data:application/pdf;base64,"))
    }
}
