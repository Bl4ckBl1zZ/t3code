import Foundation
import Testing
@testable import T3Code

/// Signed asset URLs change on every mint, and a reconnect mints again, so
/// server attachment images cache under their id instead.
@Suite("Attachment thumbnail cache keys")
struct AttachmentThumbnailCacheKeyTests {
    @Test func reMintedURLsForTheSameAttachmentShareACacheKey() {
        let identity = FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: "thread-a", attachmentID: "att-1")
        let first = FeatureAttachmentThumbnailLoader.cacheKey(
            for: URL(string: "https://host.test/api/assets/x?sig=one")!, identity: identity, maximumPixelSize: 380)
        let second = FeatureAttachmentThumbnailLoader.cacheKey(
            for: URL(string: "https://relay.test/api/assets/x?sig=two")!, identity: identity, maximumPixelSize: 380)
        #expect(first == second)
    }

    @Test func scopeAndSizeKeepAttachmentsApart() {
        let url = URL(string: "https://host.test/a")!
        let a = FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: "thread-a", attachmentID: "att-1")
        let b = FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: "thread-b", attachmentID: "att-1")
        #expect(a != b)
        // The length prefix stops one scope's tail reading as another's id.
        #expect(FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: "ab", attachmentID: "c")
            != FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: "a", attachmentID: "bc"))
        #expect(FeatureAttachmentThumbnailLoader.cacheKey(for: url, identity: a, maximumPixelSize: 168)
            != FeatureAttachmentThumbnailLoader.cacheKey(for: url, identity: a, maximumPixelSize: 1200))
    }

    @Test func withoutAScopeTheURLIsTheKey() {
        let url = URL(string: "https://host.test/a?sig=one")!
        #expect(FeatureAttachmentThumbnailLoader.attachmentIdentity(scope: nil, attachmentID: "att-1") == nil)
        #expect(FeatureAttachmentThumbnailLoader.cacheKey(for: url, identity: nil, maximumPixelSize: 168)
            == "https://host.test/a?sig=one#168")
    }
}
