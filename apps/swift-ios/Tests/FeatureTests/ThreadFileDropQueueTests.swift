import XCTest
import UniformTypeIdentifiers
@testable import T3Code

final class ThreadFileDropQueueTests: XCTestCase {
    @MainActor func testBatchBoundsProvidersAndDisclosesOmittedFiles() async {
        let providers = (0..<12).map { _ in NSItemProvider() }
        let batch = ThreadFileDropBatch(draftKey: "environment:thread", providers: providers)
        XCTAssertEqual(batch.providers.count, 8)
        XCTAssertEqual(batch.omittedCount, 4)
        XCTAssertEqual(batch.draftKey, "environment:thread")
    }

    @MainActor func testInterruptedPreparationResumesAtUnconsumedFile() async {
        let batch = ThreadFileDropBatch(draftKey: "thread", providers: [NSItemProvider(), NSItemProvider(), NSItemProvider()])
        batch.advance(expectedIndex: 0)
        // A cancelled load does not acknowledge its file. Reopening starts here.
        XCTAssertEqual(batch.nextIndex, 1)
        XCTAssertFalse(batch.isComplete)
        // A late callback from an old view cannot acknowledge a later file.
        batch.advance(expectedIndex: 0)
        XCTAssertEqual(batch.nextIndex, 1)
        batch.advance(expectedIndex: 1)
        batch.advance(expectedIndex: 2)
        XCTAssertTrue(batch.isComplete)
    }

    @MainActor func testCompletedAndEmptyBatchesStayBounded() async {
        let batch = ThreadFileDropBatch(draftKey: "thread", providers: [NSItemProvider()])
        batch.finish()
        batch.advance(expectedIndex: 1)
        XCTAssertEqual(batch.nextIndex, 1)
        XCTAssertTrue(batch.isComplete)
        XCTAssertTrue(ThreadFileDropBatch(draftKey: "empty", providers: []).isComplete)
    }

    @MainActor func testOnlyFileRepresentationsAreChosenInsteadOfURLLinks() async {
        let provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.url.identifier, visibility: .all) { completion in completion(Data(), nil); return nil }
        XCTAssertNil(ThreadFileDropBatch.supportedType(provider))
        provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in completion(Data(), nil); return nil }
        XCTAssertEqual(ThreadFileDropBatch.supportedType(provider), UTType.png.identifier)
    }
}
