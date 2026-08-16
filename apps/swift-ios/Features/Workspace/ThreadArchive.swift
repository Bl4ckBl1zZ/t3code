import Foundation

// Ported from apps/mobile/src/features/home/threadArchive.ts. The gate has to
// agree across clients: a thread archived from one device disappears on every
// other one, so a disagreement here would detach a live provider run.

public enum ThreadArchive {
    /// The runtime facts the gate reads, mirroring the React Native client's
    /// `ThreadRuntimeSummary`. `status` stays a raw string because that is what
    /// the V2 shell reports — `idle` or one of the run statuses.
    public struct Runtime: Equatable, Sendable {
        public let status: String
        public let activeRunID: String?

        public init(status: String, activeRunID: String?) {
            self.status = status
            self.activeRunID = activeRunID
        }

        /// A shell with neither a run nor a provider thread has never reached a
        /// provider, so it has no runtime at all. Mirrors `shellRuntime` in
        /// packages/client-runtime/src/state/models.ts.
        public init?(shell: OrchestrationV2ThreadShell) {
            guard shell.latestRunId != nil || shell.activeProviderThreadId != nil else {
                return nil
            }
            self.init(status: shell.status, activeRunID: shell.activeRunId)
        }
    }

    /// Statuses that mean a provider is executing a turn right now.
    private static let providerActiveStatuses: Set<String> = ["preparing", "starting", "running"]

    /// Archiving may discard queued work, but it must not detach a provider
    /// while that provider is still executing a turn.
    public static func canArchive(_ runtime: Runtime?) -> Bool {
        guard let runtime else { return true }
        // `queued` alone is not enough: the queue can be draining behind a run
        // that is still attached, and only the absent run id proves it is not.
        if runtime.status == "queued" { return runtime.activeRunID == nil }
        return !providerActiveStatuses.contains(runtime.status)
    }

    public static func canArchive(shell: OrchestrationV2ThreadShell) -> Bool {
        canArchive(Runtime(shell: shell))
    }
}
