import Foundation

public struct FeatureDraftAttachment: Identifiable, Sendable, Equatable {
    public let id: UUID
    public var data: Data
    public var thumbnailData: Data?
    public var filename: String
    public var mimeType: String

    public init(
        id: UUID = UUID(),
        data: Data,
        thumbnailData: Data? = nil,
        filename: String,
        mimeType: String
    ) {
        self.id = id
        self.data = data
        self.thumbnailData = thumbnailData
        self.filename = filename
        self.mimeType = mimeType
    }

    public var byteCount: Int {
        data.count
    }
}

public struct NewTaskRequest: Sendable, Equatable {
    public var projectID: String
    public var prompt: String
    public var selection: FeatureSelection?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode
    public var workspaceMode: FeatureWorkspaceMode
    public var branch: String?
    public var worktreePath: String?
    public var startFromOrigin: Bool
    public var attachments: [FeatureDraftAttachment]

    public init(
        projectID: String,
        prompt: String,
        selection: FeatureSelection?,
        runtimeMode: FeatureRuntimeMode,
        interactionMode: FeatureInteractionMode,
        workspaceMode: FeatureWorkspaceMode = .local,
        branch: String? = nil,
        worktreePath: String? = nil,
        startFromOrigin: Bool = true,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.projectID = projectID
        self.prompt = prompt
        self.selection = selection
        self.runtimeMode = runtimeMode.mobileNormalized
        self.interactionMode = interactionMode.mobileNormalized
        self.workspaceMode = workspaceMode
        self.branch = Self.nonEmpty(branch)
        self.worktreePath = workspaceMode == .local ? Self.nonEmpty(worktreePath) : nil
        self.startFromOrigin = workspaceMode == .worktree && startFromOrigin
        self.attachments = attachments
    }

    public var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

public struct FeatureMessageSubmission: Sendable, Equatable {
    public var threadID: String
    public var text: String
    public var selection: FeatureSelection?
    public var attachments: [FeatureDraftAttachment]

    public init(
        threadID: String,
        text: String,
        selection: FeatureSelection?,
        attachments: [FeatureDraftAttachment] = []
    ) {
        self.threadID = threadID
        self.text = text
        self.selection = selection
        self.attachments = attachments
    }
}

enum DailyUXCreationContext {
    /// A project row's menu text: the name on its own line, and below it the
    /// small location line that tells two same-named projects apart.
    ///
    /// `environments` is the set the picker actually offers. The environment is
    /// named only when more than one is in play — the New Task hero already says
    /// "on <environment>" for the current selection, so repeating it on every
    /// row would be noise. Unlike web's picker there is no local/remote split to
    /// draw: the phone reaches every environment over the network.
    static func projectMenuRow(
        for project: FeatureProject,
        in environments: [FeatureEnvironment]
    ) -> (title: String, detail: String?) {
        var parts: [String] = []
        if environments.count > 1,
           let environment = environments.first(where: { $0.id == project.environmentID }) {
            parts.append(environment.name)
        }
        // A project whose path is its whole identity (an unnamed root) would
        // otherwise read "t3code" over "t3code".
        let path = ProjectCreationPath.abbreviatingHome(project.path)
        if !path.isEmpty, path != project.name {
            parts.append(path)
        }
        return (project.name, parts.isEmpty ? nil : parts.joined(separator: " · "))
    }

    /// The projects a task can be started in.
    ///
    /// `serverConfigs` is required rather than defaulted because it is the only
    /// thing that identifies each server's T3 Work checkout, and a caller that
    /// forgot it would silently offer that checkout as somewhere to start a
    /// coding task.
    static func projects(
        in snapshot: FeatureSnapshot,
        serverConfigs: [MobileWorkspaceEnvironmentConfig]
    ) -> [FeatureProject] {
        let creatable = snapshot.projects.filter { project in
            !MobileWorkspaceRouting.isWorkBackingProject(
                environmentID: project.environmentID,
                workspaceRoot: project.path,
                serverConfigs: serverConfigs
            )
        }
        guard !snapshot.environments.isEmpty else { return creatable }
        let availableEnvironmentIDs = Set(
            snapshot.environments.compactMap { environment in
                let state = environment.isActive
                    ? snapshot.connection.state
                    : environment.connectionState
                return state == .disconnected ? nil : environment.id
            }
        )
        return creatable.filter {
            availableEnvironmentIDs.contains($0.environmentID)
        }
    }

    static func providers(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> [FeatureProvider] {
        if let project,
           let providers = snapshot.providersByEnvironment?[project.environmentID],
           !providers.isEmpty {
            return providers
        }
        guard let project,
              let activeID = snapshot.environments.first(where: \.isActive)?.id,
              project.environmentID != activeID else {
            return snapshot.providers
        }
        guard let selection = project.defaultSelection else { return [] }
        return [
            FeatureProvider(
                id: selection.providerID,
                name: selection.providerID,
                driver: selection.providerID,
                models: [
                    FeatureModel(
                        id: selection.modelID,
                        name: selection.modelID,
                        isDefault: true
                    ),
                ]
            ),
        ]
    }

    static func initialSelection(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureSelection? {
        let providers = providers(for: project, in: snapshot)
        return DailyUXModelOptions.validated(snapshot.settings.defaultSelection, in: providers)
            ?? DailyUXModelOptions.validated(project?.defaultSelection, in: providers)
            ?? DailyUXModelOptions.preferredSelection(in: providers)
    }

    static func selection(
        carrying preferredSelection: FeatureSelection?,
        to project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureSelection? {
        let providers = providers(for: project, in: snapshot)
        return DailyUXModelOptions.validated(preferredSelection, in: providers)
            ?? initialSelection(for: project, in: snapshot)
    }

    static func environmentPreferences(
        for project: FeatureProject?,
        in snapshot: FeatureSnapshot
    ) -> FeatureEnvironmentPreferences {
        let environmentID = project?.environmentID
            ?? snapshot.environments.first(where: \.isActive)?.id
        guard let environmentID else { return FeatureEnvironmentPreferences() }
        return snapshot.preferencesByEnvironment?[environmentID]
            ?? FeatureEnvironmentPreferences()
    }
}

struct DailyUXSidebarIndex {
    let pinned: [FeatureThread]
    let active: [FeatureThread]
    let snoozed: [FeatureThread]
    let settled: [FeatureThread]
    let searchResults: [FeatureThread]

    var needsInput: [FeatureThread] {
        active.filter {
            $0.state == .waitingForApproval || $0.state == .waitingForInput
        }
    }

    var failed: [FeatureThread] {
        active.filter { $0.state == .failed }
    }

    init(
        snapshot: FeatureSnapshot,
        query: String,
        projectID: String? = nil,
        now: Date = .now,
        changeRequests: [String: FeaturePullRequest] = [:]
    ) {
        let visible = snapshot.threads.filter { thread in
            guard !thread.isArchived else { return false }
            return projectID == nil || thread.projectID == projectID
        }
        // The predicates say what the thread's state *is*; whether a shelf may
        // claim the row is gated separately (environment capability, Main
        // exemption), exactly as the web sidebar partitions.
        let isShelfSnoozed = { (thread: FeatureThread) in
            thread.canShelveSnoozed && thread.isEffectivelySnoozed(at: now)
        }
        let available = visible.filter { !isShelfSnoozed($0) }
        let isSettled = { (thread: FeatureThread) in
            thread.canShelveSettled && thread.isEffectivelySettled(
                at: now,
                changeRequest: changeRequests[thread.id]
            )
        }

        pinned = available
            .filter { $0.pinnedAt != nil }
            .sorted(by: Self.creationOrder)

        active = available
            .filter { $0.pinnedAt == nil && !isSettled($0) }
            .sorted(by: Self.creationOrder)

        snoozed = visible
            .filter(isShelfSnoozed)
            .sorted { lhs, rhs in
                let lhsUntil = lhs.snoozedUntil ?? .distantFuture
                let rhsUntil = rhs.snoozedUntil ?? .distantFuture
                if lhsUntil != rhsUntil {
                    return lhsUntil < rhsUntil
                }
                return lhs.id < rhs.id
            }

        settled = available
            .filter { $0.pinnedAt == nil && isSettled($0) }
            .sorted { lhs, rhs in
                if lhs.settledSortDate != rhs.settledSortDate {
                    return lhs.settledSortDate > rhs.settledSortDate
                }
                return lhs.id < rhs.id
            }

        searchResults = Self.matchingThreads(
            pinned + active + snoozed + settled,
            snapshot: snapshot,
            query: query
        )
    }

    private static func creationOrder(_ lhs: FeatureThread, _ rhs: FeatureThread) -> Bool {
        if lhs.createdAt != rhs.createdAt {
            return lhs.createdAt > rhs.createdAt
        }
        return lhs.id < rhs.id
    }

    static func matchingThreads(
        _ candidates: [FeatureThread],
        snapshot: FeatureSnapshot,
        query: String
    ) -> [FeatureThread] {
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedQuery.isEmpty else { return [] }
        // Aggregate snapshots can include legacy fixtures with duplicate raw IDs.
        // Native projects are environment-scoped, while this defensive reduce
        // keeps search non-crashing for older callers during migration.
        let projectByID = snapshot.projects.reduce(into: [String: FeatureProject]()) {
            $0[$1.id] = $1
        }
        return candidates.filter { thread in
            let project = projectByID[thread.projectID]
            return [
                thread.title,
                thread.preview ?? "",
                project?.name ?? "",
                project?.path ?? "",
            ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
        }
    }
}

/// The Home list only needs a parent-level refresh when a thread crosses a shelf boundary.
/// Working timers and relative ages are rendered by each visible row instead.
enum DailyUXSidebarRefresh {
    static func nextBoundary(
        for threads: [FeatureThread],
        after now: Date,
        changeRequests: [String: FeaturePullRequest] = [:]
    ) -> Date? {
        threads.reduce(nil as Date?) { earliest, thread in
            // A thread no shelf may claim crosses no boundary; ticking for it
            // would rebuild the list for a move that is not going to happen.
            let snoozeBoundary = thread.canShelveSnoozed
                && thread.isEffectivelySnoozed(at: now)
                ? thread.snoozedUntil
                : nil
            let settlementBoundary = automaticSettlementBoundary(
                for: thread,
                after: now,
                changeRequest: changeRequests[thread.id]
            )
            let threadBoundary = [snoozeBoundary, settlementBoundary]
                .compactMap { $0 }
                .min()

            guard let threadBoundary else { return earliest }
            return min(earliest ?? threadBoundary, threadBoundary)
        }
    }

    private static func automaticSettlementBoundary(
        for thread: FeatureThread,
        after now: Date,
        changeRequest: FeaturePullRequest?
    ) -> Date? {
        guard thread.canShelveSettled,
              !thread.isArchived,
              !thread.isSettled,
              thread.pinnedAt == nil,
              !thread.keepsActive,
              // A change request that resolves the thread pins the shelf either
              // way — those rows are settled now and open ones never
              // inactivity-settle — so no clock tick moves them. A terminal
              // request the thread outlived is the exception, whether because
              // the user opted out of settling on merges or because the request
              // predates their latest engagement: those rows stay on the
              // ordinary inactivity clock.
              !thread.changeRequestAutoSettles(changeRequest),
              changeRequest?.state != "open",
              let autoSettleAfterDays = thread.autoSettleAfterDays,
              let lastActivityAt = thread.lastActivityAt else {
            return nil
        }
        switch thread.state {
        case .idle, .failed, .completed:
            break
        case .queued, .working, .waitingForApproval, .waitingForInput:
            return nil
        }
        let boundary = lastActivityAt.addingTimeInterval(autoSettleAfterDays * 24 * 60 * 60)
        return boundary > now ? boundary : nil
    }
}

enum SidebarRelativeAge {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "now"
        case ..<3_600:
            return "\(seconds / 60)m"
        case ..<86_400:
            return "\(seconds / 3_600)h"
        case ..<604_800:
            return "\(seconds / 86_400)d"
        case ..<31_536_000:
            return "\(seconds / 604_800)w"
        default:
            return "\(seconds / 31_536_000)y"
        }
    }

    static func accessibility(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case ..<60:
            return "Updated just now"
        case ..<3_600:
            return "Updated \(unit(seconds / 60, singular: "minute")) ago"
        case ..<86_400:
            return "Updated \(unit(seconds / 3_600, singular: "hour")) ago"
        case ..<604_800:
            return "Updated \(unit(seconds / 86_400, singular: "day")) ago"
        case ..<31_536_000:
            return "Updated \(unit(seconds / 604_800, singular: "week")) ago"
        default:
            return "Updated \(unit(seconds / 31_536_000, singular: "year")) ago"
        }
    }

    private static func unit(_ value: Int, singular: String) -> String {
        "\(value) \(singular)\(value == 1 ? "" : "s")"
    }
}

enum HomeThreadStatus: String, Sendable, Equatable {
    case approval
    case input
    case working
    /// Nothing is generating, but a delegated agent or a detached command is
    /// still running and will wake the thread.
    case background
    case failed
    case done
    case ready
}

/// The T3 Work inbox row's leading lozenge. See ``FeatureThread/workInboxBadge``.
enum WorkInboxBadge: String, Sendable, Equatable, CaseIterable {
    case needsYou
    case working
    case failed
    case done

    var label: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .failed: "Failed"
        case .done: "Done"
        }
    }

    /// Whether the row earns the accent rail down its leading edge. Only work
    /// that is blocked on the user does: a rail on every row is a rail on none,
    /// and the point is that the inbox can be triaged in one pass.
    var wantsAttentionRail: Bool {
        self == .needsYou
    }
}

enum HomeWorkingDuration {
    static func compact(since date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        guard seconds >= 60 else { return "\(seconds)s" }
        let minutes = seconds / 60
        guard minutes >= 60 else { return "\(minutes)m" }
        return "\(minutes / 60)h \(minutes % 60)m"
    }
}

extension FeatureThread {
    var homeStatus: HomeThreadStatus {
        switch state {
        case .queued, .working:
            .working
        case .waitingForApproval:
            .approval
        case .waitingForInput:
            .input
        case .failed:
            .failed
        case .completed:
            .done
        case .idle:
            // Ranked under Done, matching the web sidebar: a result the reader
            // has not seen yet outranks work that is still going.
            (backgroundWorkCount ?? 0) > 0 ? .background : .ready
        }
    }

    /// The lozenge a T3 Work inbox row leads with, in place of the project name
    /// a Code card carries there.
    ///
    /// Work is an inbox: every row is the same assistant on the same backing
    /// checkout, so naming that is a constant, and what actually differs between
    /// rows is state. Approval and input collapse into one "Needs you" because
    /// the useful distinction is that it is blocked on you at all — *what* it
    /// wants is the line underneath.
    ///
    /// `nil` for a thread with nothing to report, which leaves the row's meta
    /// line as just its age rather than badging "Ready" on everything idle.
    var workInboxBadge: WorkInboxBadge? {
        switch homeStatus {
        case .approval, .input: .needsYou
        // Background work reads as working in the inbox: the row is not yours yet.
        case .working, .background: .working
        case .failed: .failed
        case .done: .done
        case .ready: nil
        }
    }

    var homeStatusLabel: String? {
        switch homeStatus {
        case .approval: "Approval"
        case .input: "Input"
        case .working: "Working"
        case .background: "Background"
        case .failed: "Failed"
        case .done: "Done"
        case .ready: nil
        }
    }

    func homeWorkingDuration(at now: Date) -> String? {
        guard homeStatus == .working, let workingStartedAt else { return nil }
        return HomeWorkingDuration.compact(since: workingStartedAt, now: now)
    }

    func homeEnvironmentLabel(in snapshot: FeatureSnapshot) -> String? {
        let projectEnvironmentID = snapshot.projects
            .first(where: { $0.id == projectID })?
            .environmentID
        if let resolvedID = environmentID ?? projectEnvironmentID,
           let currentName = snapshot.environments.first(where: { $0.id == resolvedID })?.name,
           !currentName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return currentName
        }
        guard let environmentName = environmentName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !environmentName.isEmpty else {
            return nil
        }
        return environmentName
    }

    func homeProviderLabel(in snapshot: FeatureSnapshot) -> String? {
        if let providerName = providerName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !providerName.isEmpty {
            return providerName
        }
        guard let providerID else { return nil }
        return snapshot.providers.first(where: { $0.id == providerID })?.name ?? providerID
    }

    var needsAttention: Bool {
        state == .waitingForApproval || state == .waitingForInput || state == .failed
    }

    /// The anchor `changeRequestAutoSettles` measures a terminal change request
    /// against: the newest user-initiated event in the thread, falling back to
    /// creation time for a thread the user has not touched since starting it.
    var userActivityAnchorAt: Date {
        guard let latestUserActivityAt else { return createdAt }
        return max(createdAt, latestUserActivityAt)
    }

    /// Swift port of `changeRequestAutoSettles` in
    /// `packages/client-runtime/src/state/threadSettled.ts`.
    ///
    /// A closed change request is abandoned work and always settles; a merge
    /// only counts as finished when the user leaves that setting on. Either way
    /// it settles the thread only while it postdates every user-initiated event
    /// in it, so settling on a merge happens ONCE: a request last touched before
    /// the thread was created is inherited branch history (a new thread started
    /// at a worktree root whose PR already merged), and one older than the
    /// user's latest engagement was already adjudicated — re-engaging a thread
    /// whose PR merged is the user saying the conversation outlived the PR.
    /// A request whose last activity the server does not report keeps the old
    /// always-settle behavior.
    func changeRequestAutoSettles(_ changeRequest: FeaturePullRequest?) -> Bool {
        guard let changeRequest else { return false }
        let isTerminal = changeRequest.state == "closed"
            || (changeRequest.state == "merged" && autoSettleOnMerge)
        guard isTerminal else { return false }
        guard let updatedAt = changeRequest.updatedAt else { return true }
        return updatedAt >= userActivityAnchorAt
    }

    /// Swift port of `effectiveSettled` in
    /// `packages/client-runtime/src/state/threadSettled.ts` — keep the two in
    /// step or the same thread parks on different shelves on web and mobile.
    /// `changeRequest` is the thread's pull request when one is being observed.
    func isEffectivelySettled(at now: Date, changeRequest: FeaturePullRequest? = nil) -> Bool {
        switch state {
        case .queued, .working, .waitingForApproval, .waitingForInput:
            return false
        case .idle, .failed, .completed:
            break
        }
        if isSettled {
            return true
        }
        if keepsActive {
            return false
        }
        if changeRequestAutoSettles(changeRequest) {
            return true
        }
        // An open PR is unfinished business that blocks the inactivity path no
        // matter how quiet the thread has been.
        if changeRequest?.state == "open" {
            return false
        }
        guard let autoSettleAfterDays else {
            return false
        }
        guard let lastActivityAt else {
            return false
        }
        return now.timeIntervalSince(lastActivityAt) >= autoSettleAfterDays * 24 * 60 * 60
    }

    func isEffectivelySnoozed(at now: Date) -> Bool {
        guard let snoozedUntil, snoozedUntil > now else { return false }
        if state == .waitingForApproval || state == .waitingForInput {
            return false
        }
        if state == .failed,
           let snoozedAt,
           let attentionAt,
           attentionAt > snoozedAt {
            return false
        }
        if let snoozedAt,
           let latestTurnCompletedAt,
           latestTurnCompletedAt > snoozedAt {
            return false
        }
        return true
    }

    var settledSortDate: Date {
        settledAt ?? lastActivityAt ?? updatedAt
    }
}

struct DailyUXModelOption: Identifiable, Equatable, Hashable {
    let provider: FeatureProvider
    let model: FeatureModel

    var id: String { Self.key(providerID: provider.id, modelID: model.id) }

    static func key(providerID: String, modelID: String) -> String {
        "\(providerID)::\(modelID)"
    }
}

struct DailyUXModelCatalog {
    let all: [DailyUXModelOption]
    let favorites: [DailyUXModelOption]
    let recents: [DailyUXModelOption]
    let providerGroups: [(provider: FeatureProvider, models: [DailyUXModelOption])]

    init(
        providers: [FeatureProvider],
        query: String,
        favoriteIDs: Set<String>,
        recentIDs: [String]
    ) {
        let available = providers.filter(\.isAvailable)
        let unfiltered = available.flatMap { provider in
            provider.models.map { DailyUXModelOption(provider: provider, model: $0) }
        }
        let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = normalizedQuery.isEmpty
            ? unfiltered
            : unfiltered.filter { option in
                [
                    option.provider.name,
                    option.model.name,
                    option.model.id,
                    option.model.detail ?? "",
                    option.model.supportsImages ? "images vision" : "",
                ].contains { $0.localizedCaseInsensitiveContains(normalizedQuery) }
            }

        all = matches
        favorites = matches.filter { favoriteIDs.contains($0.id) }

        // Provider catalogs can repeat an ID (see matchingThreads above); keep
        // the first occurrence instead of trapping on duplicate keys.
        let byID = matches.reduce(into: [String: DailyUXModelOption]()) {
            $0[$1.id] = $0[$1.id] ?? $1
        }
        recents = recentIDs.compactMap { byID[$0] }.filter { !favoriteIDs.contains($0.id) }

        providerGroups = available.compactMap { provider in
            let options = matches.filter { $0.provider.id == provider.id }
            return options.isEmpty ? nil : (provider, options)
        }
    }
}

enum DailyUXModelOptions {
    static func initialSelection(
        projectDefault: FeatureSelection?,
        appDefault: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> FeatureSelection? {
        validated(projectDefault, in: providers)
            ?? validated(appDefault, in: providers)
            ?? preferredSelection(in: providers)
    }

    static func validated(
        _ selection: FeatureSelection?,
        in providers: [FeatureProvider]
    ) -> FeatureSelection? {
        guard let selection,
              let provider = providers.first(where: {
                  $0.id == selection.providerID && $0.isAvailable
              }),
              provider.models.contains(where: { $0.id == selection.modelID }) else {
            return nil
        }
        return selection
    }

    static func preferredSelection(in providers: [FeatureProvider]) -> FeatureSelection? {
        let available = providers.filter(\.isAvailable)
        let preferred = available.lazy.compactMap { provider in
            provider.models.first(where: \.isDefault).map { (provider, $0) }
        }.first
            ?? available.first.flatMap { provider in
                provider.models.first.map { (provider, $0) }
            }
        guard let (provider, model) = preferred else { return nil }
        return FeatureSelection(
            providerID: provider.id,
            modelID: model.id,
            options: defaults(for: model)
        )
    }

    static func defaults(for model: FeatureModel) -> [FeatureModelOptionSelection] {
        model.options.compactMap { descriptor in
            if let defaultValue = descriptor.defaultValue {
                return FeatureModelOptionSelection(id: descriptor.id, value: defaultValue)
            }
            switch descriptor.kind {
            case .select:
                guard let choice = descriptor.choices.first(where: \.isDefault)
                    ?? descriptor.choices.first else {
                    return nil
                }
                return FeatureModelOptionSelection(id: descriptor.id, value: .string(choice.id))
            case .boolean:
                return FeatureModelOptionSelection(id: descriptor.id, value: .boolean(false))
            }
        }
    }

    static func value(
        for descriptor: FeatureModelOptionDescriptor,
        in selections: [FeatureModelOptionSelection]
    ) -> FeatureModelOptionValue? {
        if let selected = selections.first(where: { $0.id == descriptor.id })?.value {
            return selected
        }
        if let defaultValue = descriptor.defaultValue {
            return defaultValue
        }
        switch descriptor.kind {
        case .select:
            let choice = descriptor.choices.first(where: \.isDefault)
                ?? descriptor.choices.first
            return choice.map { .string($0.id) }
        case .boolean:
            return .boolean(false)
        }
    }

    static func updating(
        _ selections: [FeatureModelOptionSelection],
        id: String,
        value: FeatureModelOptionValue
    ) -> [FeatureModelOptionSelection] {
        var next = selections.filter { $0.id != id }
        next.append(FeatureModelOptionSelection(id: id, value: value))
        return next
    }

    static func summary(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> String? {
        let labels = model.options.compactMap { descriptor -> String? in
            guard let value = value(for: descriptor, in: selections) else { return nil }
            switch value {
            case let .string(choiceID):
                return descriptor.choices.first(where: { $0.id == choiceID })?.label
            case let .boolean(isEnabled):
                return isEnabled ? descriptor.label : nil
            }
        }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    /// The compact composer gives reasoning its own non-compressible label so
    /// a long model name cannot hide the setting users change most often.
    static func reasoningSummary(
        for model: FeatureModel,
        selections: [FeatureModelOptionSelection]
    ) -> String? {
        guard let descriptor = model.options.first(where: { descriptor in
            let searchable = "\(descriptor.id) \(descriptor.label)".lowercased()
            return searchable.contains("reason")
                || searchable.contains("effort")
                || searchable.contains("thinking")
                || searchable.contains("thought")
        }), let value = value(for: descriptor, in: selections) else {
            return nil
        }

        switch value {
        case let .string(choiceID):
            return descriptor.choices.first(where: { $0.id == choiceID })?.label
        case let .boolean(isEnabled):
            return isEnabled ? descriptor.label : nil
        }
    }

    static func supportsImages(
        selection: FeatureSelection?,
        providers: [FeatureProvider]
    ) -> Bool {
        // Older environments do not advertise image capability. In that case the
        // server remains the source of truth instead of hiding attachments entirely.
        guard providers.lazy.flatMap(\.models).contains(where: \.supportsImages) else {
            return true
        }
        guard let selection,
              let provider = providers.first(where: { $0.id == selection.providerID }),
              let model = provider.models.first(where: { $0.id == selection.modelID }) else {
            return true
        }
        return model.supportsImages
    }
}
