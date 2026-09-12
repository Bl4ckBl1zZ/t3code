import Foundation
import Testing
@testable import T3Code

@Suite("File preview contracts")
struct FilePreviewContractTests {
    @Test func encodesTheActualHostAndAttachmentRequests() throws {
        struct Fixture: Decodable { let host: JSONValue; let attachment: JSONValue; let capabilities: EnvironmentDescriptor.Capabilities }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/filePreviews.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(AssetResource.mediaFile(threadID: "thread-1", path: "/tmp/report.html").jsonValue == fixture.host)
        #expect(AssetResource.documentAttachment(id: "upload-pdf", name: "report.pdf", mimeType: "application/pdf").jsonValue == fixture.attachment)
        #expect(fixture.capabilities.fileDocumentPreviews == true)
        let legacy = try JSONDecoder().decode(EnvironmentDescriptor.Capabilities.self, from: Data("{}".utf8))
        #expect(legacy.fileDocumentPreviews == nil)
    }
    @Test func preservesAbsolutePathsAndResolvesDocumentRelativeImages() {
        #expect(FeatureFilePreviewPath.isAbsolute("/tmp/report.html"))
        #expect(FeatureFilePreviewPath.isAbsolute("C:\\reports\\page.html"))
        #expect(!FeatureFilePreviewPath.isAbsolute("docs/report.html"))
        #expect(FeatureFilePreviewPath.parent("/report.md") == "/")
        #expect(FeatureFilePreviewPath.resolve("images/plot.png", relativeTo: "docs") == "docs/images/plot.png")
        #expect(FeatureFilePreviewPath.resolve("/tmp/plot.png", relativeTo: "docs") == "/tmp/plot.png")
        #expect(FeatureFilePreviewPath.resolve("../plot.png", relativeTo: "C:\\reports") == "C:\\reports/../plot.png")
    }
    @Test func hostFileNavigationPreservesTheRoot() {
        let route = ThreadActivityFileRoute.build(environmentID: "env", currentThreadID: "thread", activitySourceThreadID: "parent", relativePath: "/tmp/report.html", line: 9)
        #expect(route.absolutePath == "/tmp/report.html")
        #expect(route.line == "9")
        #expect(route.threadID == "thread")
    }
    @Test func onlyDocumentsOpenInTheDocumentViewer() {
        #expect(FeatureFilePreviewPath.isDocument("report.PDF"))
        #expect(FeatureFilePreviewPath.isDocument("page.html"))
        #expect(!FeatureFilePreviewPath.isDocument("archive.zip"))
        #expect(!FeatureFilePreviewPath.isDocument("report.pdf.exe"))
    }
}
