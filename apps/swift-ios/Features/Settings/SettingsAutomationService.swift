import Foundation

// Ported from packages/contracts/src/scheduledTask.ts and the atom commands
// apps/mobile/src/features/settings/SettingsAutomationsRouteScreen.tsx drives.
// The native client has no scheduled-task RPC yet, so the screens here talk to
// the protocol below and an adapter conforms to it once the RPCs land.

/// Launch settings an automation carries but this form does not edit. Held
/// verbatim so a mobile edit round-trips whatever an agent or the web client
/// configured instead of flattening it to mobile's defaults.
public struct FeatureScheduledTaskLaunch: Sendable, Equatable {
    /// Wire-shaped `OrchestrationV2ThreadLaunchWorkspaceStrategy`. Deliberately
    /// opaque: mobile never inspects it, and modelling it here would mean
    /// re-deriving a contract that only the server and web client act on.
    public var workspaceStrategy: JSONValue
    public var modelSelection: ModelSelection
    public var runtimeMode: String
    public var interactionMode: String

    public init(
        workspaceStrategy: JSONValue,
        modelSelection: ModelSelection,
        runtimeMode: String = "full-access",
        interactionMode: String = "default"
    ) {
        self.workspaceStrategy = workspaceStrategy
        self.modelSelection = modelSelection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
    }

    /// What a mobile-created automation launches with, matching the `else`
    /// branch of `save()` in AutomationEditSheet.tsx: a fresh worktree off main.
    public static func mobileDefault(modelSelection: ModelSelection) -> Self {
        Self(
            workspaceStrategy: .object([
                "type": .string("worktree"),
                "baseRef": .string("main"),
            ]),
            modelSelection: modelSelection
        )
    }
}

public struct FeatureScheduledTask: Identifiable, Sendable, Equatable {
    public let id: String
    public var title: String
    public var prompt: String
    public var enabled: Bool
    public var schedule: ScheduledTaskSchedule
    /// Environment-local project identifier, not the environment-scoped id
    /// `FeatureProject.id` carries.
    public var projectID: String
    /// The thread every run posts into. `nil` starts a fresh thread per run.
    public var threadID: String?
    public var launch: FeatureScheduledTaskLaunch
    /// ISO-8601 instants, echoed rather than parsed on the way in so the labels
    /// see exactly what the server reported.
    public var nextRunAt: String?
    public var lastRunAt: String?
    public var lastRunStatus: ScheduledTaskRunStatus
    public var lastRunError: String?
    public var runCount: Int

    public init(
        id: String,
        title: String,
        prompt: String,
        enabled: Bool,
        schedule: ScheduledTaskSchedule,
        projectID: String,
        threadID: String? = nil,
        launch: FeatureScheduledTaskLaunch,
        nextRunAt: String? = nil,
        lastRunAt: String? = nil,
        lastRunStatus: ScheduledTaskRunStatus = .never,
        lastRunError: String? = nil,
        runCount: Int = 0
    ) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.enabled = enabled
        self.schedule = schedule
        self.projectID = projectID
        self.threadID = threadID
        self.launch = launch
        self.nextRunAt = nextRunAt
        self.lastRunAt = lastRunAt
        self.lastRunStatus = lastRunStatus
        self.lastRunError = lastRunError
        self.runCount = runCount
    }

    public var summary: ScheduledTaskSummary {
        ScheduledTaskSummary(
            enabled: enabled,
            schedule: schedule,
            nextRunAt: nextRunAt,
            lastRunStatus: lastRunStatus
        )
    }

    public var isRunning: Bool { lastRunStatus == .running }
}

/// Create when `id` is `nil`, update otherwise. Mirrors
/// `ScheduledTaskUpsertInput` minus the fields the server fills in.
public struct FeatureScheduledTaskUpsert: Sendable, Equatable {
    public var id: String?
    public var title: String
    public var prompt: String
    public var enabled: Bool
    public var schedule: ScheduledTaskSchedule
    public var projectID: String
    public var threadID: String?
    public var launch: FeatureScheduledTaskLaunch
    /// Only set on create, so the server can attribute the automation to the
    /// surface that made it.
    public var creationSource: String?

    public init(
        id: String? = nil,
        title: String,
        prompt: String,
        enabled: Bool,
        schedule: ScheduledTaskSchedule,
        projectID: String,
        threadID: String? = nil,
        launch: FeatureScheduledTaskLaunch,
        creationSource: String? = nil
    ) {
        self.id = id
        self.title = title
        self.prompt = prompt
        self.enabled = enabled
        self.schedule = schedule
        self.projectID = projectID
        self.threadID = threadID
        self.launch = launch
        self.creationSource = creationSource
    }
}

/// Scheduled tasks are environment-scoped: two saved servers keep independent
/// schedules, so every call names the environment it acts on.
@MainActor
public protocol FeatureScheduledTaskManaging: AnyObject {
    func loadScheduledTasks(environmentID: String) async throws -> [FeatureScheduledTask]
    func upsertScheduledTask(
        environmentID: String,
        input: FeatureScheduledTaskUpsert
    ) async throws -> FeatureScheduledTask
    /// Partial update: only the enabled flag moves, so toggling a row can never
    /// revert an edit made to the same task elsewhere.
    func setScheduledTaskEnabled(
        environmentID: String,
        id: String,
        enabled: Bool
    ) async throws -> FeatureScheduledTask
    func runScheduledTaskNow(
        environmentID: String,
        id: String
    ) async throws -> FeatureScheduledTask
    func deleteScheduledTask(environmentID: String, id: String) async throws

    /// The environment's model catalog. A new automation has to be given a
    /// model up front, and the editor's picker is built from this.
    func scheduledTaskModelCatalog(
        environmentID: String
    ) async throws -> ServerConfigSnapshot?
}

@MainActor
final class EmptyFeatureScheduledTaskManager: FeatureScheduledTaskManaging {
    static let shared = EmptyFeatureScheduledTaskManager()

    private init() {}

    func loadScheduledTasks(environmentID _: String) async throws -> [FeatureScheduledTask] {
        []
    }

    func upsertScheduledTask(
        environmentID _: String,
        input _: FeatureScheduledTaskUpsert
    ) async throws -> FeatureScheduledTask {
        throw FeatureCapabilityUnavailable("Automations")
    }

    func setScheduledTaskEnabled(
        environmentID _: String,
        id _: String,
        enabled _: Bool
    ) async throws -> FeatureScheduledTask {
        throw FeatureCapabilityUnavailable("Automations")
    }

    func runScheduledTaskNow(
        environmentID _: String,
        id _: String
    ) async throws -> FeatureScheduledTask {
        throw FeatureCapabilityUnavailable("Automations")
    }

    func deleteScheduledTask(environmentID _: String, id _: String) async throws {
        throw FeatureCapabilityUnavailable("Automations")
    }

    func scheduledTaskModelCatalog(
        environmentID _: String
    ) async throws -> ServerConfigSnapshot? {
        nil
    }
}

// MARK: - Editor state

/// Form state for the automation editor, ported from `Draft` in
/// AutomationEditSheet.tsx. Kept free of SwiftUI so the validation the Save
/// button depends on is testable without rendering the sheet.
public struct AutomationDraft: Equatable, Sendable {
    public enum ScheduleMode: String, CaseIterable, Sendable {
        case fixed
        case interval
    }

    public var title = ""
    public var prompt = ""
    public var isEnabled = true
    public var scheduleMode: ScheduleMode = .fixed
    /// Free text rather than a number: the field is a keyboard entry, and
    /// holding the raw string is what lets the editor mark it invalid in place.
    public var intervalMinutes = "15"
    public var timeOfDay = "09:00"
    public var weekdays: Set<ScheduledTaskWeekday> = [
        .monday, .tuesday, .wednesday, .thursday, .friday,
    ]
    /// Environment-local project identifier. Empty until one is chosen.
    public var projectID = ""
    /// `nil` starts a fresh thread on every run.
    public var threadID: String?
    /// `nil` on a new automation until the catalog resolves a default.
    public var modelSelection: ModelSelection?

    public init() {}

    public init(task: FeatureScheduledTask) {
        title = task.title
        prompt = task.prompt
        isEnabled = task.enabled
        projectID = task.projectID
        threadID = task.threadID
        modelSelection = task.launch.modelSelection

        switch task.schedule {
        case let .interval(everyMs):
            scheduleMode = .interval
            intervalMinutes = String(
                max(1, Int((Double(everyMs) / 60_000).rounded()))
            )
        case let .fixedTime(time, days):
            scheduleMode = .fixed
            timeOfDay = time
            // An absent or empty weekday list means every day, and the picker
            // shows that as all seven selected rather than as none.
            if let days, !days.isEmpty {
                weekdays = Set(days)
            } else {
                weekdays = Set(ScheduledTaskWeekday.allCases)
            }
        }
    }

    /// `nil` when the entered schedule is not something the server would accept,
    /// which is also what disables Save.
    public var schedule: ScheduledTaskSchedule? {
        switch scheduleMode {
        case .interval:
            guard let minutes = ScheduledTaskLabels.parseIntervalMinutes(intervalMinutes) else {
                return nil
            }
            return .interval(everyMs: minutes * 60_000)
        case .fixed:
            guard ScheduledTaskLabels.isValidTimeOfDay(timeOfDay) else { return nil }
            // No selected day would mean the automation never fires, so it is
            // rejected rather than silently widened to daily.
            guard !weekdays.isEmpty else { return nil }
            let isEveryDay = weekdays.count == ScheduledTaskWeekday.allCases.count
            return .fixedTime(
                timeOfDay: timeOfDay.trimmingCharacters(in: .whitespacesAndNewlines),
                weekdays: isEveryDay ? nil : weekdays.sorted { $0.rawValue < $1.rawValue }
            )
        }
    }

    public var isTimeOfDayValid: Bool {
        ScheduledTaskLabels.isValidTimeOfDay(timeOfDay)
    }

    public var isIntervalValid: Bool {
        ScheduledTaskLabels.parseIntervalMinutes(intervalMinutes) != nil
    }

    public var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Every field the reader fills in is present. Deliberately does not require
    /// a model: React Native leaves Save enabled and reports a missing model as
    /// an alert, because "no provider is authenticated here" is worth saying out
    /// loud rather than expressing as a permanently greyed-out button.
    public var isComplete: Bool {
        !trimmedTitle.isEmpty
            && !trimmedPrompt.isEmpty
            && !projectID.isEmpty
            && schedule != nil
    }

    public mutating func toggle(_ weekday: ScheduledTaskWeekday) {
        if weekdays.contains(weekday) {
            weekdays.remove(weekday)
        } else {
            weekdays.insert(weekday)
        }
    }

    /// The upsert this draft describes, or `nil` when it is not yet complete.
    /// `existing` supplies the launch settings an edit must preserve.
    public func upsert(editing existing: FeatureScheduledTask?) -> FeatureScheduledTaskUpsert? {
        guard let schedule, let modelSelection, isComplete else { return nil }
        let launch: FeatureScheduledTaskLaunch
        if var preserved = existing?.launch {
            preserved.modelSelection = modelSelection
            launch = preserved
        } else {
            launch = .mobileDefault(modelSelection: modelSelection)
        }
        return FeatureScheduledTaskUpsert(
            id: existing?.id,
            title: trimmedTitle,
            prompt: trimmedPrompt,
            enabled: isEnabled,
            schedule: schedule,
            projectID: projectID,
            threadID: threadID,
            launch: launch,
            creationSource: existing == nil ? "mobile" : nil
        )
    }
}

/// Monday-first, matching how a week reads, while the stored numbering stays
/// Sunday-zero because that is what the wire contract uses.
public extension ScheduledTaskWeekday {
    static let pickerOrder: [ScheduledTaskWeekday] = [
        .monday, .tuesday, .wednesday, .thursday, .friday, .saturday, .sunday,
    ]

    /// Two letters so all seven fit a phone width without wrapping.
    var initials: String {
        switch self {
        case .sunday: "Su"
        case .monday: "Mo"
        case .tuesday: "Tu"
        case .wednesday: "We"
        case .thursday: "Th"
        case .friday: "Fr"
        case .saturday: "Sa"
        }
    }

    var accessibilityName: String {
        switch self {
        case .sunday: "Sunday"
        case .monday: "Monday"
        case .tuesday: "Tuesday"
        case .wednesday: "Wednesday"
        case .thursday: "Thursday"
        case .friday: "Friday"
        case .saturday: "Saturday"
        }
    }
}
