import Testing
import UniformTypeIdentifiers
@testable import T3Code

@Suite("Media export")
struct MediaExportTests {
    @Test
    func usesOriginalMediaTypeAndRejectsErrorDocuments() {
        #expect(MediaExport.fileType(mimeType: "image/png", pathExtension: "") == .png)
        #expect(MediaExport.fileType(mimeType: "video/mp4", pathExtension: "")?.conforms(to: .movie) == true)
        #expect(MediaExport.fileType(mimeType: nil, pathExtension: "jpeg") == .jpeg)
        #expect(MediaExport.fileType(mimeType: "text/html", pathExtension: "png") == nil)
    }
}
