import Foundation
import Observation
import UniformTypeIdentifiers

/// Providers remain associated with the destination until its composer consumes
/// them. Leaving the thread cancels preparation without redirecting the files.
@MainActor @Observable
final class ThreadFileDropBatch {
    let id = UUID()
    let draftKey: String
    let providers: [NSItemProvider]
    private(set) var nextIndex = 0
    let omittedCount: Int

    init(draftKey: String, providers: [NSItemProvider]) {
        self.draftKey = draftKey
        self.providers = Array(providers.prefix(8))
        omittedCount = max(0, providers.count - 8)
    }
    var isComplete: Bool { nextIndex >= providers.count }
    func advance(expectedIndex: Int) {
        if nextIndex == expectedIndex { nextIndex = min(providers.count, nextIndex + 1) }
    }
    func finish() { nextIndex = providers.count }

    static func supportedType(_ provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url)
        }
    }
}
