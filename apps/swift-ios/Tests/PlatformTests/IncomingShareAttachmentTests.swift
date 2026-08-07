import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import T3Code

/// Covers the widened share extension, ported from
/// apps/mobile/src/features/sharing/incoming-share-model.ts.
final class IncomingShareAttachmentTests: XCTestCase {
    // MARK: - What a provider is read as

    func testImagesAndMoviesBecomeAttachmentsAndCarryTheRightCap() {
        let image = T3SharedAttachmentTypes.selection(
            forRegisteredTypeIdentifiers: [UTType.png.identifier, UTType.url.identifier]
        )
        let movie = T3SharedAttachmentTypes.selection(
            forRegisteredTypeIdentifiers: [UTType.quickTimeMovie.identifier]
        )

        XCTAssertEqual(image, .attachment(typeIdentifier: UTType.png.identifier, isImage: true))
        XCTAssertEqual(
            movie,
            .attachment(typeIdentifier: UTType.quickTimeMovie.identifier, isImage: false)
        )
    }

    func testArbitraryFilesBecomeAttachments() {
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.pdf.identifier]
            ),
            .attachment(typeIdentifier: UTType.pdf.identifier, isImage: false)
        )
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.zip.identifier]
            ),
            .attachment(typeIdentifier: UTType.zip.identifier, isImage: false)
        )
    }

    /// A web URL is a link to paste into the prompt; a file URL is a file. A
    /// naive "URL first" pass turns every shared photo and document into a link.
    func testWebURLsBecomeMessageTextWhileFileURLsBecomeAttachments() {
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.url.identifier]
            ),
            .webURL(typeIdentifier: UTType.url.identifier)
        )
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.fileURL.identifier, UTType.pdf.identifier]
            ),
            // The concrete type names the file better than `public.file-url`.
            .attachment(typeIdentifier: UTType.pdf.identifier, isImage: false)
        )
    }

    /// A provider that advertises nothing but a file URL still has to produce an
    /// attachment; dropping it is how a shared file silently disappears.
    func testABareFileURLIsStillReadAsAnAttachment() {
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.fileURL.identifier]
            ),
            .attachment(typeIdentifier: UTType.fileURL.identifier, isImage: false)
        )
    }

    /// Plain text conforms to `public.data`, so the generic-file branch has to
    /// exclude it or shared text arrives as a `.txt` attachment.
    func testPlainTextStaysMessageText() {
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.plainText.identifier]
            ),
            .plainText(typeIdentifier: UTType.plainText.identifier)
        )
        XCTAssertEqual(
            T3SharedAttachmentTypes.selection(
                forRegisteredTypeIdentifiers: [UTType.utf8PlainText.identifier]
            ),
            .plainText(typeIdentifier: UTType.utf8PlainText.identifier)
        )
    }

    func testAProviderWithNothingUsableIsSkipped() {
        XCTAssertNil(T3SharedAttachmentTypes.selection(forRegisteredTypeIdentifiers: []))
        XCTAssertNil(
            T3SharedAttachmentTypes.selection(forRegisteredTypeIdentifiers: ["not.a.real.uti"])
        )
    }

    // MARK: - Caps

    func testTheExtensionAcceptsEightOfEachAndTheContractCaps() {
        // Matches supportsImage/Movie/FileWithMaxCount in Extensions/Share/Info.plist.
        XCTAssertEqual(T3IncomingShareStore.maximumAttachmentCount, 8)
        XCTAssertEqual(
            T3IncomingShareStore.maximumAttachmentCount,
            PlatformIncomingSharePipeline.maximumAttachmentCount
        )
        // The extension is a separate module, so its restated caps must agree
        // with the shared rules the app validates against.
        XCTAssertEqual(
            T3IncomingShareStore.maximumImageBytes,
            ComposerAttachments.maximumImageBytes
        )
        XCTAssertEqual(
            T3IncomingShareStore.maximumFileBytes,
            ComposerAttachments.maximumFileBytes
        )
        XCTAssertEqual(T3IncomingShareStore.maximumBytes(isImage: true), 10 * 1_024 * 1_024)
        XCTAssertEqual(T3IncomingShareStore.maximumBytes(isImage: false), 20 * 1_024 * 1_024)
    }

    // MARK: - Pre-read validation

    func testAMovieUnderTheFileCapIsAcceptedEvenThoughItExceedsTheImageCap() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "demo.mov",
            mimeType: "video/quicktime",
            byteCount: 15 * 1_024 * 1_024
        )

        guard case let .accepted(accepted) = outcome else {
            return XCTFail("Expected a 15 MB movie to be accepted: \(outcome)")
        }
        XCTAssertEqual(accepted.kind, .video)
        XCTAssertEqual(accepted.mimeType, "video/quicktime")
        XCTAssertEqual(accepted.name, "demo.mov")
    }

    func testAnImageOverTenMegabytesIsRejectedBeforeItIsRead() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "huge.png",
            mimeType: "image/png",
            byteCount: 12 * 1_024 * 1_024
        )

        XCTAssertEqual(outcome, .rejected("'huge.png' is 12 MB — over the 10 MB limit for an image."))
    }

    /// Just over the cap rounds to the same number as the cap, and
    /// "is 20 MB — over the 20 MB limit" reads like a bug.
    func testAFileJustOverTheCapDoesNotReportTheSameNumberTwice() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "archive.zip",
            mimeType: "application/zip",
            byteCount: 20 * 1_024 * 1_024 + 1
        )

        XCTAssertEqual(outcome, .rejected("'archive.zip' is over the 20 MB limit for a file."))
    }

    func testAnEmptyFileIsRejected() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.validate(
                fileName: "folder",
                mimeType: "",
                byteCount: 0
            ),
            .rejected("'folder' is empty and wasn't attached.")
        )
    }

    func testTheMimeTypeIsInferredFromTheExtensionWhenTheProviderOffersNone() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "notes.md",
            mimeType: "  ",
            byteCount: 512
        )

        XCTAssertEqual(
            outcome,
            .accepted(
                PlatformIncomingShareValidation.Accepted(
                    kind: .file,
                    mimeType: "text/markdown",
                    name: "notes.md"
                )
            )
        )
    }

    func testAnUnknownExtensionFallsBackToAGenericFileRatherThanBeingRejected() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "capture",
            mimeType: "",
            byteCount: 64
        )

        // Audio, archives, executables, extensionless blobs: the agent's to
        // open, not ours to gatekeep.
        XCTAssertEqual(
            outcome,
            .accepted(
                PlatformIncomingShareValidation.Accepted(
                    kind: .file,
                    mimeType: "application/octet-stream",
                    name: "capture"
                )
            )
        )
    }

    func testAMalformedMimeTypeIsRejected() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.validate(
                fileName: "thing",
                mimeType: "not a mime type",
                byteCount: 10
            ),
            .rejected("'thing' has no usable file type and wasn't attached.")
        )
    }

    func testPdfsKeepTheirOwnKindRatherThanCollapsingToFile() {
        let outcome = PlatformIncomingShareValidation.validate(
            fileName: "spec.pdf",
            mimeType: "application/pdf",
            byteCount: 1_024
        )

        guard case let .accepted(accepted) = outcome else {
            return XCTFail("Expected the PDF to be accepted: \(outcome)")
        }
        XCTAssertEqual(accepted.kind, .pdf)
    }

    // MARK: - Name sanitization

    /// `report.pdf<RLO>gpj.exe` renders as `report.pdfexe.jpg` in a chip the
    /// user is about to trust.
    func testBidiOverridesAndControlCharactersAreStripped() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.sanitizedName("report.pdf\u{202E}gpj.exe"),
            "report.pdfgpj.exe"
        )
        XCTAssertEqual(
            PlatformIncomingShareValidation.sanitizedName("na\u{0007}me.txt"),
            "name.txt"
        )
    }

    func testPathSeparatorsAndDotNamesNeverSurviveIntoAnAttachmentName() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.sanitizedName("../../etc/passwd"),
            "..-..-etc-passwd"
        )
        XCTAssertEqual(PlatformIncomingShareValidation.sanitizedName(".."), "file")
        XCTAssertEqual(PlatformIncomingShareValidation.sanitizedName("."), "file")
    }

    func testAnUnusableNameIsRejectedOutright() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.validate(fileName: "   ", mimeType: "", byteCount: 10),
            .rejected("Attachment names must be plain file names.")
        )
    }

    func testALongNameIsTruncatedWithItsExtensionIntact() {
        let name = String(repeating: "a", count: 400) + ".png"

        let sanitized = PlatformIncomingShareValidation.sanitizedName(name)

        XCTAssertEqual(sanitized.count, PlatformIncomingShareValidation.maximumNameLength)
        XCTAssertTrue(sanitized.hasSuffix(".png"))
    }

    /// A 40-character "extension" is a filename with a dot in it; treating it as
    /// an extension would truncate away the informative part of the name.
    func testOnlyAPlausibleTrailingExtensionIsTreatedAsOne() {
        XCTAssertEqual(
            PlatformIncomingShareValidation.splitFileExtension("archive.tar.gz").extension,
            ".gz"
        )
        XCTAssertEqual(
            PlatformIncomingShareValidation.splitFileExtension("v1.2.3-release-candidate").extension,
            ""
        )
        XCTAssertEqual(PlatformIncomingShareValidation.splitFileExtension("plain").extension, "")
    }

    func testSizesAreFormattedAgainstTheSameBaseAsTheCaps() {
        XCTAssertEqual(PlatformIncomingShareValidation.formattedSize(0), "0 B")
        XCTAssertEqual(PlatformIncomingShareValidation.formattedSize(512), "512 B")
        XCTAssertEqual(PlatformIncomingShareValidation.formattedSize(2_048), "2 KB")
        XCTAssertEqual(PlatformIncomingShareValidation.formattedSize(10 * 1_024 * 1_024), "10 MB")
        XCTAssertEqual(
            PlatformIncomingShareValidation.formattedSize(3 * 1_024 * 1_024 / 2),
            "1.5 MB"
        )
    }

    // MARK: - Shared items becoming draft attachments

    /// Only images go through the image processor: it re-encodes to JPEG and
    /// builds a thumbnail, and handing it a movie leaves the composer spinning
    /// on a decode that never completes.
    func testAMovieBecomesADraftAttachmentWithoutTouchingTheImageProcessor() async throws {
        let recorder = SharePipelineRecorder()
        let pipeline = Self.pipeline(
            recorder: recorder,
            bytes: Data(repeating: 0xAB, count: 4)
        )
        let envelope = Self.envelope(attachments: [
            Self.attachment(
                id: "11111111-2222-3333-4444-555555555555",
                fileName: "demo.mov",
                mimeType: "video/quicktime",
                byteCount: 15 * 1_024 * 1_024
            ),
        ])

        let result = try await pipeline.importEnvelope(envelope, into: Self.project())
        let prepared = await recorder.prepared
        let imageOrdinals = await recorder.imageOrdinals

        XCTAssertTrue(imageOrdinals.isEmpty)
        XCTAssertEqual(prepared.count, 1)
        XCTAssertEqual(prepared.first?.filename, "demo.mov")
        XCTAssertEqual(prepared.first?.mimeType, "video/quicktime")
        XCTAssertEqual(prepared.first?.data, Data(repeating: 0xAB, count: 4))
        XCTAssertNil(prepared.first?.thumbnailData)
        XCTAssertTrue(result.warnings.isEmpty)
    }

    func testImagesStillRunThroughTheProcessorAndKeepTheirStableIdentifier() async throws {
        let recorder = SharePipelineRecorder()
        let pipeline = Self.pipeline(recorder: recorder, bytes: Data([0xCA, 0xFE]))
        let id = try XCTUnwrap(UUID(uuidString: "11111111-2222-3333-4444-555555555555"))
        let envelope = Self.envelope(attachments: [
            Self.attachment(
                id: id.uuidString,
                fileName: "shot.png",
                mimeType: "image/png",
                byteCount: 2
            ),
        ])

        _ = try await pipeline.importEnvelope(envelope, into: Self.project())
        let prepared = await recorder.prepared
        let imageOrdinals = await recorder.imageOrdinals

        XCTAssertEqual(imageOrdinals, [1])
        XCTAssertEqual(prepared.first?.id, id)
        XCTAssertEqual(prepared.first?.mimeType, "image/jpeg")
    }

    /// A rejected file must not fail the whole import: the user shared five
    /// things and wants the four that are legal.
    func testARejectedFileBecomesAWarningWithoutBlockingTheRest() async throws {
        let recorder = SharePipelineRecorder()
        let pipeline = Self.pipeline(recorder: recorder, bytes: Data([0x01]))
        let envelope = Self.envelope(attachments: [
            Self.attachment(
                id: "11111111-2222-3333-4444-555555555555",
                fileName: "huge.png",
                mimeType: "image/png",
                byteCount: 12 * 1_024 * 1_024
            ),
            Self.attachment(
                id: "22222222-3333-4444-5555-666666666666",
                fileName: "notes.md",
                mimeType: "text/markdown",
                byteCount: 32
            ),
        ])

        let result = try await pipeline.importEnvelope(envelope, into: Self.project())
        let prepared = await recorder.prepared
        let reads = await recorder.reads

        XCTAssertEqual(prepared.map(\.filename), ["notes.md"])
        // Rejected before reading: no reason to pull 12 MB into memory first.
        XCTAssertEqual(reads, ["notes.md"])
        XCTAssertEqual(
            result.warnings,
            ["'huge.png' is 12 MB — over the 10 MB limit for an image."]
        )
    }

    func testWarningsRaisedByTheExtensionSurviveTheImport() async throws {
        let recorder = SharePipelineRecorder()
        let pipeline = Self.pipeline(recorder: recorder, bytes: Data([0x01]))
        var envelope = Self.envelope(attachments: [])
        envelope.text = "Prompt"
        envelope.warnings = ["Only the first 8 shared files were attached."]

        let result = try await pipeline.importEnvelope(envelope, into: Self.project())

        XCTAssertEqual(result.warnings, ["Only the first 8 shared files were attached."])
    }

    // MARK: - Envelope compatibility

    /// Shares saved by the pre-widening build are still on disk in the App
    /// Group; nothing prunes an undecodable one, so they would be stranded.
    func testAPreWideningEnvelopeStillDecodes() throws {
        let json = """
        {
          "schemaVersion": 1,
          "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          "createdAt": "2026-08-01T12:00:00Z",
          "text": "Look at this",
          "images": [
            {
              "id": "11111111-2222-3333-4444-555555555555",
              "fileName": "shot.png",
              "typeIdentifier": "public.png",
              "relativePath": "inbox/shot.png",
              "byteCount": 2048
            }
          ],
          "warnings": []
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let envelope = try decoder.decode(
            T3IncomingShareEnvelope.self,
            from: Data(json.utf8)
        )

        XCTAssertEqual(envelope.attachments.count, 1)
        XCTAssertEqual(envelope.attachments.first?.fileName, "shot.png")
        // Derived from the UTI it was always given.
        XCTAssertEqual(envelope.attachments.first?.mimeType, "image/png")
    }

    func testANewEnvelopeRoundTripsThroughTheAttachmentsKey() throws {
        let envelope = T3IncomingShareEnvelope(
            schemaVersion: T3IncomingShareEnvelope.schemaVersion,
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            createdAt: Date(timeIntervalSince1970: 100),
            text: "Prompt",
            attachments: [
                T3IncomingShareAttachment(
                    id: "11111111-2222-3333-4444-555555555555",
                    fileName: "demo.mov",
                    typeIdentifier: "com.apple.quicktime-movie",
                    mimeType: "video/quicktime",
                    relativePath: "inbox/demo.mov",
                    byteCount: 15 * 1_024 * 1_024
                ),
            ],
            warnings: ["One file was skipped."]
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let data = try encoder.encode(envelope)
        let keys = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        ).keys

        XCTAssertTrue(keys.contains("attachments"))
        XCTAssertFalse(keys.contains("images"))
        XCTAssertEqual(try decoder.decode(T3IncomingShareEnvelope.self, from: data), envelope)
    }

    // MARK: - Fixtures

    private static func pipeline(
        recorder: SharePipelineRecorder,
        bytes: Data
    ) -> PlatformIncomingSharePipeline {
        PlatformIncomingSharePipeline(
            source: PlatformIncomingShareSource(
                loadAll: { [] },
                data: { shared in
                    await recorder.recordRead(shared.fileName)
                    return bytes
                },
                remove: { _ in }
            ),
            drafts: PlatformIncomingShareDraftRepository(
                importContent: { _, text, attachments, _, _ in
                    await recorder.recordPrepared(attachments)
                    return FeatureComposerDraft(text: text, attachments: attachments)
                }
            ),
            prepareImage: { data, ordinal in
                await recorder.recordImage(ordinal)
                return FeatureDraftAttachment(
                    data: data,
                    thumbnailData: Data([0x00]),
                    filename: "Image \(ordinal).jpg",
                    mimeType: "image/jpeg"
                )
            }
        )
    }

    private static func envelope(
        attachments: [T3IncomingShareAttachment]
    ) -> T3IncomingShareEnvelope {
        T3IncomingShareEnvelope(
            schemaVersion: T3IncomingShareEnvelope.schemaVersion,
            id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            createdAt: Date(timeIntervalSince1970: 100),
            text: "",
            attachments: attachments,
            warnings: []
        )
    }

    private static func attachment(
        id: String,
        fileName: String,
        mimeType: String,
        byteCount: Int
    ) -> T3IncomingShareAttachment {
        T3IncomingShareAttachment(
            id: id,
            fileName: fileName,
            typeIdentifier: "public.data",
            mimeType: mimeType,
            relativePath: "inbox/\(fileName)",
            byteCount: byteCount
        )
    }

    private static func project() -> FeatureProject {
        FeatureProject(
            id: "project:environment:project",
            wireID: "project",
            environmentID: "environment",
            name: "t3code",
            path: "/repo"
        )
    }
}

private actor SharePipelineRecorder {
    private(set) var reads: [String] = []
    private(set) var imageOrdinals: [Int] = []
    private(set) var prepared: [FeatureDraftAttachment] = []

    func recordRead(_ name: String) {
        reads.append(name)
    }

    func recordImage(_ ordinal: Int) {
        imageOrdinals.append(ordinal)
    }

    func recordPrepared(_ attachments: [FeatureDraftAttachment]) {
        prepared = attachments
    }
}
