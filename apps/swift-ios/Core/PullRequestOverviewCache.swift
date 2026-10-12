import CryptoKit
import Foundation

/// The last pull-request overviews (detail and activity) this device read, so
/// a pull request opened while its environment is unreachable shows what it
/// last looked like instead of an error.
///
/// Read only when the live read fails for want of a connection; every
/// successful read replaces the entry. One file per pull request under a
/// directory per environment, least recently saved evicted first, and an
/// overview larger than `maxEntryBytes` is not kept. Like `SyncSnapshotCache`
/// it lives in Application Support (excluded from backups), holds no
/// credentials, is dropped with its environment, and entries from another app
/// build are ignored and swept.
actor PullRequestOverviewCache {
    struct Key: Hashable, Sendable {
        let environmentID: String
        /// The server's project id, the repository's display name and the number:
        /// the same pull request read through a thread or a project.
        let projectID: String
        let repository: String
        let number: Int

        fileprivate var fileName: String { Self.hash("\(projectID)\u{0}\(repository.lowercased())\u{0}\(number)") + ".json" }
        fileprivate var directoryName: String { Self.hash(environmentID) }

        fileprivate static func hash(_ value: String) -> String {
            SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
        }
    }

    private struct Entry: Codable {
        let savedAt: Date
        let detail: PullRequestDetail
        let activity: PullRequestActivity?
    }

    private let root: URL
    private let directory: URL
    private let maxEntries: Int
    private let maxEntryBytes: Int

    /// - Parameters:
    ///   - directory: Defaults to `Application Support/T3CodeSwift/PullRequestCache`.
    ///   - build: Entries live under a directory per build; others are swept.
    init(
        directory: URL? = nil,
        build: String = SyncSnapshotCache.currentBuild,
        maxEntries: Int = 40,
        maxEntryBytes: Int = 1_048_576
    ) {
        let root = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("T3CodeSwift", isDirectory: true)
            .appendingPathComponent("PullRequestCache", isDirectory: true)
        self.root = root
        self.directory = root.appendingPathComponent(Key.hash(build), isDirectory: true)
        self.maxEntries = maxEntries
        self.maxEntryBytes = maxEntryBytes
    }

    /// The saved overview, marked with when it was saved.
    func overview(for key: Key) -> FeaturePullRequestOverview? {
        let url = fileURL(key)
        guard let data = try? Data(contentsOf: url),
              let entry = try? JSONDecoder().decode(Entry.self, from: data) else { return nil }
        return FeaturePullRequestOverview(detail: entry.detail, activity: entry.activity, savedAt: entry.savedAt)
    }

    func save(_ overview: FeaturePullRequestOverview, for key: Key, at date: Date = .now) {
        let url = fileURL(key)
        guard let data = try? JSONEncoder().encode(Entry(savedAt: date, detail: overview.detail, activity: overview.activity)) else { return }
        let manager = FileManager.default
        guard data.count <= maxEntryBytes else {
            try? manager.removeItem(at: url)
            return
        }
        sweepOtherBuilds()
        do {
            try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            // The write time is the eviction order, so a re-save keeps an entry.
            try manager.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        } catch {
            return
        }
        evict()
    }

    func removeEnvironment(_ environmentID: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(Key.hash(environmentID), isDirectory: true))
    }

    /// Classifies a read failure as the environment being out of reach, the
    /// only time a saved copy stands in for the live one.
    static func isOffline(_ error: any Error) -> Bool {
        switch error {
        case RPCError.connectionUnavailable, RPCError.disconnected, RPCError.responseTimedOut: true
        case is URLError: true
        default: false
        }
    }

    private func fileURL(_ key: Key) -> URL {
        directory.appendingPathComponent(key.directoryName, isDirectory: true).appendingPathComponent(key.fileName)
    }

    private var sweptOtherBuilds = false

    private func sweepOtherBuilds() {
        guard !sweptOtherBuilds else { return }
        sweptOtherBuilds = true
        let manager = FileManager.default
        for url in (try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where url.lastPathComponent != directory.lastPathComponent {
            try? manager.removeItem(at: url)
        }
    }

    private func evict() {
        let manager = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        let environments = (try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let files = environments.flatMap { (try? manager.contentsOfDirectory(at: $0, includingPropertiesForKeys: keys)) ?? [] }
        guard files.count > maxEntries else { return }
        let dated = files.map { url in
            (url, (try? url.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast)
        }
        for (url, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(files.count - maxEntries) {
            try? manager.removeItem(at: url)
        }
    }
}
