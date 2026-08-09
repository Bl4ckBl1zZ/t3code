import Foundation

/// Remembers the project the new-task sheet was last pointed at, so opening it
/// again preselects that project instead of whatever happens to sort first.
///
/// Kept per environment as well as globally: switching computers inside the
/// sheet then follows the project last used *on that computer* rather than
/// resetting to its first project.
public struct NewTaskProjectMemory: Codable, Equatable, Sendable {
    public var lastEnvironmentID: String?
    public var projectIDByEnvironment: [String: String]

    public init(
        lastEnvironmentID: String? = nil,
        projectIDByEnvironment: [String: String] = [:]
    ) {
        self.lastEnvironmentID = lastEnvironmentID
        self.projectIDByEnvironment = projectIDByEnvironment
    }

    public func rememberedProjectID(forEnvironment environmentID: String) -> String? {
        projectIDByEnvironment[environmentID]
    }

    /// The remembered project to preselect, or `nil` when nothing remembered is
    /// still creatable — the caller then falls back to its own default.
    public func preferredProjectID(in projects: [FeatureProject]) -> String? {
        if let lastEnvironmentID,
           let projectID = projectIDByEnvironment[lastEnvironmentID],
           projects.contains(where: {
               $0.id == projectID && $0.environmentID == lastEnvironmentID
           }) {
            return projectID
        }
        // The environment last used can disappear (server removed, project
        // deleted). Any other remembered project still beats "first in the
        // list"; walking `projects` keeps the choice deterministic.
        return projects.first { projectIDByEnvironment[$0.environmentID] == $0.id }?.id
    }

    public mutating func record(projectID: String, environmentID: String) {
        lastEnvironmentID = environmentID
        projectIDByEnvironment[environmentID] = projectID
    }
}

/// `UserDefaults`-backed home for ``NewTaskProjectMemory``. Read once when the
/// sheet appears and written on every project selection, so the preference
/// survives relaunches the same way the workspace switcher's does.
public final class NewTaskProjectMemoryStore: @unchecked Sendable {
    public static let shared = NewTaskProjectMemoryStore()

    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    public init(
        defaults: UserDefaults = .standard,
        key: String = "swift-ios.new-task.project.v1"
    ) {
        self.defaults = defaults
        self.key = key
    }

    public func memory() -> NewTaskProjectMemory {
        lock.withLock { decodeUnlocked() }
    }

    public func record(projectID: String, environmentID: String) {
        lock.withLock {
            var memory = decodeUnlocked()
            guard memory.lastEnvironmentID != environmentID
                || memory.projectIDByEnvironment[environmentID] != projectID else { return }
            memory.record(projectID: projectID, environmentID: environmentID)
            guard let data = try? JSONEncoder().encode(memory) else { return }
            defaults.set(data, forKey: key)
        }
    }

    private func decodeUnlocked() -> NewTaskProjectMemory {
        guard let data = defaults.data(forKey: key),
              let memory = try? JSONDecoder().decode(NewTaskProjectMemory.self, from: data) else {
            return NewTaskProjectMemory()
        }
        return memory
    }
}
