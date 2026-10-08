import CryptoKit
import Foundation
import os

/// The last shell and thread projections this device saw, so Home and a
/// reopened thread paint before the network answers.
///
/// A thread entry pairs a projection with the stream sequence it is current
/// through. Opening the thread renders the projection and subscribes with
/// `afterSequence` set to that sequence; the server replays the gap or, when
/// the gap is too large or the cursor unknown, sends a fresh snapshot. The pair
/// is always written together, so a stale entry is only ever behind, never
/// inconsistent.
///
/// Saves land in memory before they return, so an open that follows a save
/// always sees it; encoding and disk writes happen afterwards off the caller,
/// and a write older than what the disk already holds is dropped.
///
/// Everything here is a cache. It lives in Application Support (excluded from
/// backups), carries no credentials — projections hold transcript content and
/// `secret_request` items carry only a label, reason, placeholder and status,
/// never the value — and is dropped when its environment is removed. Entries
/// written by another app build are discarded, because a model change could
/// otherwise decode an old file with fields silently defaulted.
final class SyncSnapshotCache: Sendable {
    struct ThreadSnapshot: Equatable, Sendable {
        /// Nil for a projection with no resume cursor, such as the one a
        /// thread launch replies with. It paints, but the subscription must ask
        /// for a fresh snapshot rather than resume.
        let sequence: Int?
        let projection: OrchestrationV2ThreadProjection
    }

    struct Limits: Sendable {
        /// Threads kept on disk across every environment, least recently
        /// opened evicted first.
        var maxThreads = 40
        /// Decoded projections kept in memory for in-session reopen.
        var memoryThreads = 4
        /// A projection larger than this is not written; the older entry stays.
        var maxThreadBytes = 2 * 1024 * 1024
        /// A projection showing more items than this (the full history after
        /// "load earlier") is not written: reopening would map all of it.
        var maxVisibleItems = 240
    }

    fileprivate struct Key: Hashable, Sendable {
        let environmentID: String
        let threadID: String
    }

    let directory: URL
    private let limits: Limits
    private let store: SyncSnapshotStore
    private let recent: OSAllocatedUnfairLock<RecentThreads>

    /// - Parameters:
    ///   - directory: Defaults to `Application Support/T3CodeSwift/SyncCache`.
    ///   - build: Entries from any other build are discarded on read.
    ///   - now: Stamps last use for eviction; injected so tests need no sleeps.
    init(
        directory: URL? = nil,
        build: String = SyncSnapshotCache.currentBuild,
        limits: Limits = Limits(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        let directory = directory ?? FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first!
            .appendingPathComponent("T3CodeSwift", isDirectory: true)
            .appendingPathComponent("SyncCache", isDirectory: true)
        self.directory = directory
        self.limits = limits
        store = SyncSnapshotStore(
            directory: directory,
            format: "1-\(build)",
            limits: limits,
            now: now
        )
        recent = OSAllocatedUnfairLock(initialState: RecentThreads(capacity: limits.memoryThreads))
    }

    static var currentBuild: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(version)-\(build)"
    }

    // MARK: Threads

    func thread(environmentID: String, threadID: String) async -> ThreadSnapshot? {
        let key = Key(environmentID: environmentID, threadID: threadID)
        if let held = recent.withLock({ $0.get(key) }) {
            if held.sequence != nil {
                // Disk eviction orders by last open, wherever it was served;
                // the open itself does not wait on the disk.
                let store = store
                Task.detached(priority: .utility) { await store.touch(key) }
            }
            return held
        }
        guard let loaded = await store.thread(key) else { return nil }
        // A save may have landed while the disk read was in flight.
        return recent.withLock { recent in
            recent.adopt(loaded, for: key)
            return recent.get(key)
        }
    }

    /// Holds a projection that has no sequence yet, in memory only, so the
    /// first open of a just-launched thread paints without a request.
    func seedThread(
        _ projection: OrchestrationV2ThreadProjection,
        environmentID: String,
        threadID: String
    ) {
        let key = Key(environmentID: environmentID, threadID: threadID)
        recent.withLock { $0.adopt(ThreadSnapshot(sequence: nil, projection: projection), for: key) }
    }

    /// Records the projection as current through `sequence`, then writes it.
    /// An older sequence than the one already held is ignored, in memory and
    /// on disk, so a late save never rewinds the entry. The returned task is
    /// the disk write.
    @discardableResult
    func saveThread(
        _ projection: OrchestrationV2ThreadProjection,
        sequence: Int,
        environmentID: String,
        threadID: String
    ) -> Task<Void, Never>? {
        let key = Key(environmentID: environmentID, threadID: threadID)
        let snapshot = ThreadSnapshot(sequence: sequence, projection: projection)
        guard recent.withLock({ $0.save(snapshot, for: key) }),
              projection.visibleTurnItems.count <= limits.maxVisibleItems else { return nil }
        let store = store
        return Task.detached(priority: .utility) {
            await store.saveThread(projection, sequence: sequence, key: key)
        }
    }

    func removeThread(environmentID: String, threadID: String) async {
        let key = Key(environmentID: environmentID, threadID: threadID)
        recent.withLock { $0.remove(key) }
        await store.removeThread(key)
    }

    // MARK: Shells

    func shell(environmentID: String) async -> OrchestrationV2ShellSnapshot? {
        await store.shell(environmentID: environmentID)
    }

    /// Saves the environment's shell and drops cached threads it no longer
    /// lists as active: deleted and archived threads leave the cache here. A
    /// launch seed stays, since the shell may predate the launch. The
    /// returned task is the disk write.
    @discardableResult
    func saveShell(
        _ shell: OrchestrationV2ShellSnapshot,
        environmentID: String
    ) -> Task<Void, Never> {
        let threadIDs = Set(shell.threads.map(\.id))
        recent.withLock { $0.retain(environmentID: environmentID, threadIDs: threadIDs) }
        let store = store
        return Task.detached(priority: .utility) {
            await store.saveShell(shell, environmentID: environmentID)
        }
    }

    /// Removes everything held for an environment that was removed.
    func removeEnvironment(_ environmentID: String) async {
        recent.withLock { $0.removeEnvironment(environmentID) }
        await store.removeEnvironment(environmentID)
    }
}

/// The decoded projections opened most recently, least recent first.
private struct RecentThreads: Sendable {
    let capacity: Int
    private var entries: [SyncSnapshotCache.Key: SyncSnapshotCache.ThreadSnapshot] = [:]
    private var order: [SyncSnapshotCache.Key] = []

    init(capacity: Int) {
        self.capacity = capacity
    }

    mutating func get(_ key: SyncSnapshotCache.Key) -> SyncSnapshotCache.ThreadSnapshot? {
        guard let entry = entries[key] else { return nil }
        touch(key)
        return entry
    }

    /// Takes a read or a seed unless something at least as new is held.
    mutating func adopt(_ snapshot: SyncSnapshotCache.ThreadSnapshot, for key: SyncSnapshotCache.Key) {
        guard entries[key] == nil else { return }
        insert(snapshot, for: key)
    }

    /// False when a newer sequence is already held.
    mutating func save(_ snapshot: SyncSnapshotCache.ThreadSnapshot, for key: SyncSnapshotCache.Key) -> Bool {
        if let held = entries[key]?.sequence, let next = snapshot.sequence, held > next {
            return false
        }
        insert(snapshot, for: key)
        return true
    }

    mutating func remove(_ key: SyncSnapshotCache.Key) {
        entries[key] = nil
        order.removeAll { $0 == key }
    }

    mutating func retain(environmentID: String, threadIDs: Set<String>) {
        for (key, entry) in entries
            where key.environmentID == environmentID
            && entry.sequence != nil
            && !threadIDs.contains(key.threadID) {
            remove(key)
        }
    }

    mutating func removeEnvironment(_ environmentID: String) {
        for key in entries.keys where key.environmentID == environmentID {
            remove(key)
        }
    }

    private mutating func insert(_ snapshot: SyncSnapshotCache.ThreadSnapshot, for key: SyncSnapshotCache.Key) {
        entries[key] = snapshot
        touch(key)
        while order.count > capacity {
            entries[order.removeFirst()] = nil
        }
    }

    private mutating func touch(_ key: SyncSnapshotCache.Key) {
        order.removeAll { $0 == key }
        order.append(key)
    }
}

/// The disk half of ``SyncSnapshotCache``: one JSON file per shell and per
/// thread, under hashed names.
private actor SyncSnapshotStore {
    private struct ThreadDocument: Codable {
        let format: String
        let environmentID: String
        let threadID: String
        let sequence: Int
        let projection: OrchestrationV2ThreadProjection
    }

    private struct ShellDocument: Codable {
        let format: String
        let environmentID: String
        let shell: OrchestrationV2ShellSnapshot
    }

    private let directory: URL
    private let format: String
    private let limits: SyncSnapshotCache.Limits
    private let now: @Sendable () -> Date
    /// The newest sequence on disk per thread and per shell, so a write that
    /// arrives late does not replace a newer one.
    private var writtenThreadSequences: [SyncSnapshotCache.Key: Int] = [:]
    private var writtenShellSequences: [String: Int] = [:]
    private var preparedDirectory = false

    init(
        directory: URL,
        format: String,
        limits: SyncSnapshotCache.Limits,
        now: @escaping @Sendable () -> Date
    ) {
        self.directory = directory
        self.format = format
        self.limits = limits
        self.now = now
    }

    func thread(_ key: SyncSnapshotCache.Key) -> SyncSnapshotCache.ThreadSnapshot? {
        let url = threadURL(key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let document = try? JSONDecoder.t3.decode(ThreadDocument.self, from: data),
              document.format == format,
              document.environmentID == key.environmentID,
              document.threadID == key.threadID else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        touch(key)
        writtenThreadSequences[key] = max(writtenThreadSequences[key] ?? 0, document.sequence)
        return SyncSnapshotCache.ThreadSnapshot(sequence: document.sequence, projection: document.projection)
    }

    func touch(_ key: SyncSnapshotCache.Key) {
        try? FileManager.default.setAttributes(
            [.modificationDate: now()],
            ofItemAtPath: threadURL(key).path
        )
    }

    func saveThread(
        _ projection: OrchestrationV2ThreadProjection,
        sequence: Int,
        key: SyncSnapshotCache.Key
    ) {
        if let written = writtenThreadSequences[key], written > sequence { return }
        let document = ThreadDocument(
            format: format,
            environmentID: key.environmentID,
            threadID: key.threadID,
            sequence: sequence,
            projection: projection
        )
        guard let data = try? JSONEncoder.t3Intermediate.encode(document),
              data.count <= limits.maxThreadBytes,
              write(data, to: threadURL(key)) else { return }
        writtenThreadSequences[key] = sequence
        evictThreads()
    }

    func removeThread(_ key: SyncSnapshotCache.Key) {
        writtenThreadSequences[key] = nil
        try? FileManager.default.removeItem(at: threadURL(key))
    }

    func shell(environmentID: String) -> OrchestrationV2ShellSnapshot? {
        let url = shellURL(environmentID)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let document = try? JSONDecoder.t3.decode(ShellDocument.self, from: data),
              document.format == format,
              document.environmentID == environmentID else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return document.shell
    }

    func saveShell(_ shell: OrchestrationV2ShellSnapshot, environmentID: String) {
        if let written = writtenShellSequences[environmentID], written > shell.snapshotSequence {
            return
        }
        let document = ShellDocument(format: format, environmentID: environmentID, shell: shell)
        guard let data = try? JSONEncoder.t3Intermediate.encode(document),
              write(data, to: shellURL(environmentID)) else { return }
        writtenShellSequences[environmentID] = shell.snapshotSequence
        retainThreads(environmentID: environmentID, threadIDs: Set(shell.threads.map(\.id)))
    }

    func removeEnvironment(_ environmentID: String) {
        writtenShellSequences[environmentID] = nil
        writtenThreadSequences = writtenThreadSequences.filter { $0.key.environmentID != environmentID }
        try? FileManager.default.removeItem(at: shellURL(environmentID))
        try? FileManager.default.removeItem(at: threadDirectory(environmentID))
    }

    private func retainThreads(environmentID: String, threadIDs: Set<String>) {
        let kept = Set(threadIDs.map { Self.fileName($0) + ".json" })
        let directory = threadDirectory(environmentID)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for file in files where !kept.contains(file) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(file))
        }
        writtenThreadSequences = writtenThreadSequences.filter {
            $0.key.environmentID != environmentID || threadIDs.contains($0.key.threadID)
        }
    }

    private func evictThreads() {
        let root = directory.appendingPathComponent("threads", isDirectory: true)
        let manager = FileManager.default
        let environments = (try? manager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil
        )) ?? []
        var files: [(url: URL, used: Date)] = []
        for environment in environments {
            let entries = (try? manager.contentsOfDirectory(
                at: environment,
                includingPropertiesForKeys: [.contentModificationDateKey]
            )) ?? []
            for entry in entries {
                let used = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate ?? .distantPast
                files.append((entry, used))
            }
        }
        guard files.count > limits.maxThreads else { return }
        let oldestFirst = files.sorted { $0.used < $1.used }
        for file in oldestFirst.prefix(files.count - limits.maxThreads) {
            try? manager.removeItem(at: file.url)
        }
    }

    private func write(_ data: Data, to url: URL) -> Bool {
        let manager = FileManager.default
        do {
            if !preparedDirectory {
                try manager.createDirectory(at: directory, withIntermediateDirectories: true)
                var root = directory
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? root.setResourceValues(values)
                preparedDirectory = true
            }
            try manager.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            try? manager.setAttributes([.modificationDate: now()], ofItemAtPath: url.path)
            return true
        } catch {
            return false
        }
    }

    private func threadDirectory(_ environmentID: String) -> URL {
        directory
            .appendingPathComponent("threads", isDirectory: true)
            .appendingPathComponent(Self.fileName(environmentID), isDirectory: true)
    }

    private func threadURL(_ key: SyncSnapshotCache.Key) -> URL {
        threadDirectory(key.environmentID)
            .appendingPathComponent(Self.fileName(key.threadID) + ".json")
    }

    private func shellURL(_ environmentID: String) -> URL {
        directory
            .appendingPathComponent("shells", isDirectory: true)
            .appendingPathComponent(Self.fileName(environmentID) + ".json")
    }

    /// Wire ids are server-chosen strings; hashing keeps them path-safe.
    private static func fileName(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8))
            .prefix(16)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
