import Foundation

public struct FeatureConnection: Sendable, Equatable, Codable {
    public enum State: String, Sendable, Hashable, Codable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    public var state: State
    public var environmentName: String?
    public var endpoint: String?
    public var detail: String?

    public init(
        state: State = .disconnected,
        environmentName: String? = nil,
        endpoint: String? = nil,
        detail: String? = nil
    ) {
        self.state = state
        self.environmentName = environmentName
        self.endpoint = endpoint
        self.detail = detail
    }
}

public struct FeatureEnvironment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var endpoint: String
    public var isActive: Bool
    /// Reachability from the latest aggregate refresh. `nil` means the client
    /// has not probed this saved environment yet.
    public var connectionState: FeatureConnection.State?
    public var connectionDetail: String?

    public init(
        id: String,
        name: String,
        endpoint: String,
        isActive: Bool = false,
        connectionState: FeatureConnection.State? = nil,
        connectionDetail: String? = nil
    ) {
        self.id = id
        self.name = name
        self.endpoint = endpoint
        self.isActive = isActive
        self.connectionState = connectionState
        self.connectionDetail = connectionDetail
    }
}

public struct FeatureProject: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The environment-local identifier sent over the wire. Native aggregate
    /// snapshots scope `id` by environment so cloned databases remain distinct.
    public var wireID: String?
    public var environmentID: String
    public var name: String
    public var path: String
    public var threadCount: Int
    public var defaultSelection: FeatureSelection?
    /// The project's configured scripts, verbatim from `OrchestrationProject`.
    /// The details sheet lists them as run rows and names ports after the script
    /// that opened them, so a port row without these degrades to "Port 5173".
    public var scripts: [ProjectScript]
    /// `previewUrl` from the project's checked-in `t3.json`.
    ///
    /// Unlike a script's own `previewUrl`, this one is *pinned*: it is the user
    /// saying "this project lives here", not evidence that anything is
    /// listening, so the Ports section lists it from the moment a thread opens
    /// and keeps listing it after the server stops.
    public var previewUrl: String?

    public init(
        id: String,
        wireID: String? = nil,
        environmentID: String,
        name: String,
        path: String,
        threadCount: Int = 0,
        defaultSelection: FeatureSelection? = nil,
        scripts: [ProjectScript] = [],
        previewUrl: String? = nil
    ) {
        self.id = id
        self.wireID = wireID
        self.environmentID = environmentID
        self.name = name
        self.path = path
        self.threadCount = threadCount
        self.defaultSelection = defaultSelection
        self.scripts = scripts
        self.previewUrl = previewUrl
    }

    /// `ProjectScript` is a Core wire type and is deliberately not `Hashable`,
    /// so hashing folds in the script identities rather than the whole rows.
    /// Equality still compares every field, which is all `Hashable` requires.
    public func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(wireID)
        hasher.combine(environmentID)
        hasher.combine(name)
        hasher.combine(path)
        hasher.combine(threadCount)
        hasher.combine(defaultSelection)
        hasher.combine(previewUrl)
        for script in scripts { hasher.combine(script.id) }
    }
}

public enum FeatureThreadState: String, Sendable, Codable {
    case idle
    case queued
    case working
    case waitingForApproval
    case waitingForInput
    case failed
    case completed
}

public enum FeatureRuntimeMode: String, CaseIterable, Sendable, Codable {
    case approvalRequired
    case autoAcceptEdits
    case automatic
    case fullAccess

    /// Mobile is a build surface. Legacy modes remain decodable for server
    /// history, but every command originating here uses full access.
    public static let allCases: [FeatureRuntimeMode] = [.fullAccess]

    public var mobileNormalized: FeatureRuntimeMode {
        .fullAccess
    }
}

public enum FeatureInteractionMode: String, CaseIterable, Sendable, Codable {
    case standard
    case plan

    /// Plan remains decodable for existing server state, but is no longer a
    /// mobile prompt choice.
    public static let allCases: [FeatureInteractionMode] = [.standard]

    public var mobileNormalized: FeatureInteractionMode { .standard }
}

public struct FeatureThread: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The environment-local identifier sent over the wire.
    public var wireID: String?
    public var projectID: String
    public var environmentID: String?
    public var environmentName: String?
    public var title: String
    public var preview: String?
    public var branch: String?
    public var worktreePath: String?
    public var createdAt: Date
    public var updatedAt: Date
    public var state: FeatureThreadState
    public var providerID: String?
    public var providerName: String?
    public var modelID: String?
    public var modelOptions: [FeatureModelOptionSelection]
    public var isArchived: Bool
    public var isSettled: Bool
    public var keepsActive: Bool
    public var settledAt: Date?
    public var lastActivityAt: Date?
    public var snoozedUntil: Date?
    public var snoozedAt: Date?
    public var pinnedAt: Date?
    public var supportsPinning: Bool?
    /// `main` marks the thread the T3 Work inbox pins to the top as the current
    /// main line of work. Absent means an ordinary thread. The inbox's Main
    /// section does not exist without this.
    public var workInboxRole: String?
    /// `fork`, `subagent`, or nil for a root thread. Subagent threads are
    /// excluded from both workspaces: they are steps inside their parent, not
    /// work of their own.
    public var relationshipToParent: String?
    /// A title regeneration is in flight, so the row shimmers its title instead
    /// of showing a stale one that is about to be replaced.
    public var isRegeneratingTitle: Bool
    /// Whether the environment can regenerate a title at all. `nil` means an
    /// older cached descriptor that never reported the capability.
    public var supportsTitleRegeneration: Bool?
    public var attentionAt: Date?
    public var workingStartedAt: Date?
    public var latestTurnCompletedAt: Date?
    public var runtimeMode: FeatureRuntimeMode
    public var interactionMode: FeatureInteractionMode

    public init(
        id: String,
        wireID: String? = nil,
        projectID: String,
        environmentID: String? = nil,
        environmentName: String? = nil,
        title: String,
        preview: String? = nil,
        branch: String? = nil,
        worktreePath: String? = nil,
        createdAt: Date = .now,
        updatedAt: Date = .now,
        state: FeatureThreadState = .idle,
        providerID: String? = nil,
        providerName: String? = nil,
        modelID: String? = nil,
        modelOptions: [FeatureModelOptionSelection] = [],
        isArchived: Bool = false,
        isSettled: Bool = false,
        keepsActive: Bool = false,
        settledAt: Date? = nil,
        lastActivityAt: Date? = nil,
        snoozedUntil: Date? = nil,
        snoozedAt: Date? = nil,
        pinnedAt: Date? = nil,
        supportsPinning: Bool? = nil,
        workInboxRole: String? = nil,
        relationshipToParent: String? = nil,
        isRegeneratingTitle: Bool = false,
        supportsTitleRegeneration: Bool? = nil,
        attentionAt: Date? = nil,
        workingStartedAt: Date? = nil,
        latestTurnCompletedAt: Date? = nil,
        runtimeMode: FeatureRuntimeMode = .fullAccess,
        interactionMode: FeatureInteractionMode = .standard
    ) {
        self.id = id
        self.wireID = wireID
        self.projectID = projectID
        self.environmentID = environmentID
        self.environmentName = environmentName
        self.title = title
        self.preview = preview
        self.branch = branch
        self.worktreePath = worktreePath
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.state = state
        self.providerID = providerID
        self.providerName = providerName
        self.modelID = modelID
        self.modelOptions = modelOptions
        self.isArchived = isArchived
        self.isSettled = isSettled
        self.keepsActive = keepsActive
        self.settledAt = settledAt
        self.lastActivityAt = lastActivityAt
        self.snoozedUntil = snoozedUntil
        self.snoozedAt = snoozedAt
        self.pinnedAt = pinnedAt
        self.supportsPinning = supportsPinning
        self.workInboxRole = workInboxRole
        self.relationshipToParent = relationshipToParent
        self.isRegeneratingTitle = isRegeneratingTitle
        self.supportsTitleRegeneration = supportsTitleRegeneration
        self.attentionAt = attentionAt
        self.workingStartedAt = workingStartedAt
        self.latestTurnCompletedAt = latestTurnCompletedAt
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
    }

    /// Older cached environment descriptors may omit the optional capability even
    /// when their server supports pinning. Always keep an existing pin reversible.
    public var canTogglePin: Bool {
        pinnedAt != nil || supportsPinning != false
    }

    /// As with pinning, an absent capability means "this descriptor predates the
    /// flag", not "the server cannot do it" — and a regeneration already in
    /// flight is proof that it can.
    public var canRegenerateTitle: Bool {
        isRegeneratingTitle || supportsTitleRegeneration != false
    }

    /// Subagent threads are steps inside their parent's timeline, not work of
    /// their own, so neither workspace lists them as a row.
    public var isSubagentThread: Bool {
        relationshipToParent == "subagent"
    }
}

public enum FeatureMessageRole: String, Sendable, Codable {
    case user
    case assistant
    case system
    case tool
}

public enum FeatureMessageState: String, Sendable, Codable {
    case queued
    case streaming
    case complete
    case failed
}

public struct FeatureMessageAttachment: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var mimeType: String
    public var sizeBytes: Int
    public var url: URL?
    /// Small local preview retained only while an optimistic message is replaced
    /// by its server-backed attachment URL.
    public var previewData: Data?

    public init(
        id: String,
        name: String,
        mimeType: String,
        sizeBytes: Int,
        url: URL? = nil,
        previewData: Data? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.url = url
        self.previewData = previewData
    }
}

public struct FeatureUploadAttachment: Sendable, Equatable {
    public var data: Data
    public var name: String
    public var mimeType: String

    public init(data: Data, name: String, mimeType: String) {
        self.data = data
        self.name = name
        self.mimeType = mimeType
    }
}

public struct FeatureMessage: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var role: FeatureMessageRole
    public var text: String
    public var createdAt: Date
    public var state: FeatureMessageState
    public var toolName: String?
    public var attachments: [FeatureMessageAttachment]

    public init(
        id: String,
        role: FeatureMessageRole,
        text: String,
        createdAt: Date = .now,
        state: FeatureMessageState = .complete,
        toolName: String? = nil,
        attachments: [FeatureMessageAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.state = state
        self.toolName = toolName
        self.attachments = attachments
    }
}

public enum FeatureApprovalKind: String, Sendable, Codable {
    case command
    case fileRead
    case fileChange
    case patch
    case other
}

public struct FeatureApproval: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The provider request identifier sent over the wire.
    public var wireID: String?
    public var threadID: String
    public var kind: FeatureApprovalKind
    public var title: String
    public var detail: String

    public init(
        id: String,
        wireID: String? = nil,
        threadID: String,
        kind: FeatureApprovalKind,
        title: String,
        detail: String
    ) {
        self.id = id
        self.wireID = wireID
        self.threadID = threadID
        self.kind = kind
        self.title = title
        self.detail = detail
    }
}

public struct FeatureInputOption: Sendable, Equatable, Hashable, Codable {
    public var label: String
    public var detail: String

    public init(label: String, detail: String) {
        self.label = label
        self.detail = detail
    }
}

/// A provider answer is either free-form/single-select text or the selected
/// labels for a multi-select question. Its Codable shape intentionally matches
/// the provider wire contract: a JSON string or an array of JSON strings.
public enum FeatureInputAnswer: Sendable, Equatable, Hashable, Codable {
    case text(String)
    case selections([String])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .text(value)
        } else {
            self = try .selections(container.decode([String].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .text(value):
            try container.encode(value)
        case let .selections(values):
            try container.encode(values)
        }
    }
}

extension FeatureInputAnswer {
    var normalized: FeatureInputAnswer? {
        switch self {
        case let .text(value):
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? nil : .text(normalized)
        case let .selections(values):
            var seen: Set<String> = []
            let normalized = values.compactMap { value -> String? in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { return nil }
                return trimmed
            }
            return normalized.isEmpty ? nil : .selections(normalized)
        }
    }

    func togglingOption(_ label: String, allowsMultiple: Bool) -> FeatureInputAnswer {
        guard allowsMultiple else { return .text(label) }

        let current: [String]
        if case let .selections(values) = self {
            current = values
        } else {
            current = []
        }

        if current.contains(label) {
            return .selections(current.filter { $0 != label })
        }
        return .selections(current + [label])
    }
}

public struct FeatureInputQuestion: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var header: String
    public var question: String
    public var options: [FeatureInputOption]
    public var allowsMultiple: Bool

    public init(
        id: String,
        header: String,
        question: String,
        options: [FeatureInputOption] = [],
        allowsMultiple: Bool = false
    ) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.allowsMultiple = allowsMultiple
    }
}

public struct FeatureUserInput: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    /// The provider request identifier sent over the wire.
    public var wireID: String?
    public var threadID: String
    public var questions: [FeatureInputQuestion]

    public init(
        id: String,
        wireID: String? = nil,
        threadID: String,
        questions: [FeatureInputQuestion]
    ) {
        self.id = id
        self.wireID = wireID
        self.threadID = threadID
        self.questions = questions
    }
}

/// Stable UI identity for entities merged from independent environments.
/// Length-prefixing avoids separator collisions without requiring IDs to be parsed.
enum FeatureScopedID {
    static func project(environmentID: String, wireID: String) -> String {
        make(kind: "project", environmentID: environmentID, wireID: wireID)
    }

    static func thread(environmentID: String, wireID: String) -> String {
        make(kind: "thread", environmentID: environmentID, wireID: wireID)
    }

    static func approval(environmentID: String, wireID: String) -> String {
        make(kind: "approval", environmentID: environmentID, wireID: wireID)
    }

    static func input(environmentID: String, wireID: String) -> String {
        make(kind: "input", environmentID: environmentID, wireID: wireID)
    }

    private static func make(kind: String, environmentID: String, wireID: String) -> String {
        "\(kind):\(environmentID.utf8.count):\(environmentID)\(wireID)"
    }
}

public struct FeatureThreadDetail: Sendable, Equatable, Codable {
    public var thread: FeatureThread
    public var messages: [FeatureMessage]
    public var approvals: [FeatureApproval]
    public var userInputs: [FeatureUserInput]
    public var page: FeatureThreadPage?

    // MARK: Projection passthrough
    //
    // `messages` is the flattened transcript: one rendered row per turn item,
    // which is all the plain message list needs. Every richer timeline surface —
    // the work log, the lifecycle dividers, the activity inspector, the
    // relationship rows — reads the projection itself, so the detail carries it
    // alongside rather than making those surfaces refetch it.
    //
    // These five are deliberately outside `CodingKeys`: `LifecycleTimelineRun`,
    // `ThreadActivityItemSupport` and `FeatureThreadWorkflow` are presentation
    // value types with no wire form, and a detail is never persisted — it is
    // rebuilt from the projection on every snapshot.

    /// The projection's visible turn items, in position order.
    public var timelineItems: [OrchestrationV2ProjectedTurnItem] = []
    /// The thread's runs, narrowed to what handoff rows read to recover which
    /// model was speaking before the handoff.
    public var timelineRuns: [LifecycleTimelineRun] = []
    /// The relational rows that enrich one item, keyed by
    /// ``OrchestrationV2ProjectedTurnItem/id``.
    public var itemSupport: [String: ThreadActivityItemSupport] = [:]
    /// Subagent id to the *feature-scoped* id of the thread it spawned.
    ///
    /// The raw child id is already on the `subagent` turn item; what a surface
    /// cannot derive on its own is the environment scope that makes it routable,
    /// which is the whole reason this map exists. Covers the subagents with a
    /// row in `timelineItems`, which is exactly the set a timeline row can be
    /// tapped from.
    public var subagentChildThreadIDs: [String: String] = [:]
    /// The projection's relational tables, narrowed to what the queue control
    /// and the relationship graph take as input. One field rather than ten so a
    /// caller that rebuilds a detail from parts carries it across in one line.
    public var workflow: FeatureThreadWorkflow = .empty

    public init(
        thread: FeatureThread,
        messages: [FeatureMessage] = [],
        approvals: [FeatureApproval] = [],
        userInputs: [FeatureUserInput] = [],
        page: FeatureThreadPage? = nil,
        timelineItems: [OrchestrationV2ProjectedTurnItem] = [],
        timelineRuns: [LifecycleTimelineRun] = [],
        itemSupport: [String: ThreadActivityItemSupport] = [:],
        subagentChildThreadIDs: [String: String] = [:],
        workflow: FeatureThreadWorkflow = .empty
    ) {
        self.thread = thread
        self.messages = messages
        self.approvals = approvals
        self.userInputs = userInputs
        self.page = page
        self.timelineItems = timelineItems
        self.timelineRuns = timelineRuns
        self.itemSupport = itemSupport
        self.subagentChildThreadIDs = subagentChildThreadIDs
        self.workflow = workflow
    }

    private enum CodingKeys: String, CodingKey {
        case thread
        case messages
        case approvals
        case userInputs
        case page
    }

    /// The relational support for one projected row, or the empty value when the
    /// projection carried nothing to join against.
    public func support(
        for item: OrchestrationV2ProjectedTurnItem
    ) -> ThreadActivityItemSupport {
        itemSupport[item.id] ?? .empty
    }
}

/// The relational half of a thread projection, narrowed to the value types
/// ``ThreadWorkflows`` and ``ThreadRelationships`` already accept.
///
/// Thread ids appear in two scopes here and the difference is load bearing.
/// `runs`, `providerTurns`, `providerThreads` and `providerSessions` only ever
/// join against each other inside a single projection, so they keep the
/// server's wire ids. `thread`, `subagents` and `transfers` leave the
/// projection: the relationship rows match them against
/// ``FeatureSnapshot/threads`` and route taps by feature id, so those carry
/// *feature-scoped* thread ids instead.
public struct FeatureThreadWorkflow: Sendable, Equatable {
    /// The projection thread's wire id — the anchor
    /// ``ThreadWorkflows`` matches provider threads against when resolving the
    /// session. Empty on the placeholder value, which resolves no session.
    public var appThreadID: String
    /// `thread.activeProviderThreadId`, the fallback when no run names one.
    public var activeProviderThreadID: String?
    public var runs: [ThreadWorkflowRun]
    public var providerTurns: [ThreadWorkflowProviderTurn]
    public var providerThreads: [ThreadWorkflowProviderThread]
    public var providerSessions: [ThreadWorkflowSession]
    /// Message text keyed by message id, for the runs that are actually queued.
    /// Narrowed to those on purpose: the transcript already carries every other
    /// message, and the queue only ever renders these.
    public var queuedMessageTexts: [String: String]
    public var queuedMessageAttachmentCounts: [String: Int]
    /// The open thread as the relationship graph reads it, feature-scoped.
    public var thread: ThreadRelationshipShell?
    /// The projection's own subagent table — authoritative, and the only source
    /// that carries the workflow and usage annotations a row renders.
    public var subagents: [ThreadRelationshipSubagentLink]
    public var transfers: [ThreadRelationshipTransferLink]

    public init(
        appThreadID: String = "",
        activeProviderThreadID: String? = nil,
        runs: [ThreadWorkflowRun] = [],
        providerTurns: [ThreadWorkflowProviderTurn] = [],
        providerThreads: [ThreadWorkflowProviderThread] = [],
        providerSessions: [ThreadWorkflowSession] = [],
        queuedMessageTexts: [String: String] = [:],
        queuedMessageAttachmentCounts: [String: Int] = [:],
        thread: ThreadRelationshipShell? = nil,
        subagents: [ThreadRelationshipSubagentLink] = [],
        transfers: [ThreadRelationshipTransferLink] = []
    ) {
        self.appThreadID = appThreadID
        self.activeProviderThreadID = activeProviderThreadID
        self.runs = runs
        self.providerTurns = providerTurns
        self.providerThreads = providerThreads
        self.providerSessions = providerSessions
        self.queuedMessageTexts = queuedMessageTexts
        self.queuedMessageAttachmentCounts = queuedMessageAttachmentCounts
        self.thread = thread
        self.subagents = subagents
        self.transfers = transfers
    }

    /// What a client that cannot supply the projection reports: no queue, no
    /// detach affordance, and a relationship graph built from whatever the
    /// transcript alone yields.
    public static let empty = FeatureThreadWorkflow()

    /// The session the thread is currently attached to, or the newest live one.
    public var providerSession: ThreadWorkflowSession? {
        ThreadWorkflows.resolveProviderSession(
            appThreadID: appThreadID,
            threadActiveProviderThreadID: activeProviderThreadID,
            runs: runs,
            providerThreads: providerThreads,
            providerSessions: providerSessions
        )
    }

    /// The queue readout above the composer. Derived rather than stored so it
    /// cannot disagree with the runs it came from.
    public var queueState: ThreadQueueWorkflowState {
        ThreadWorkflows.deriveQueueWorkflowState(
            runs: runs,
            providerTurns: providerTurns,
            session: providerSession,
            messageTexts: queuedMessageTexts,
            messageAttachmentCounts: queuedMessageAttachmentCounts
        )
    }

    /// Whether "Disconnect agent" has a session to act on.
    public var canDetachProviderSession: Bool {
        ThreadWorkflows.canDetachProviderSession(providerSession)
    }

    /// The relationship model for this thread.
    ///
    /// - Parameters:
    ///   - relatedThreads: Shells for the threads the graph may reference,
    ///     live first and archived after, all feature-scoped. The open thread
    ///     itself does not need to be included — ``thread`` is prepended.
    ///   - subagents: Extra subagent edges recovered from the transcript, for
    ///     the rows the projection's own table does not cover. Projection rows
    ///     win: they carry the workflow and usage annotations.
    public func relationships(
        relatedThreads: [ThreadRelationshipShell] = [],
        additionalSubagents: [ThreadRelationshipSubagentLink] = []
    ) -> ThreadRelationshipsModel? {
        guard let thread else { return nil }
        var links = subagents
        var seen = Set(subagents.map(\.id))
        for link in additionalSubagents where seen.insert(link.id).inserted {
            links.append(link)
        }
        return ThreadRelationships.build(
            currentThreadID: thread.id,
            currentThread: thread,
            threads: [thread] + relatedThreads,
            subagents: links,
            transfers: transfers,
            runs: runs,
            providerSession: providerSession
        )
    }
}

public struct FeatureThreadPage: Sendable, Equatable, Codable {
    public var beforeCursor: String?
    public var hasMore: Bool
    public var isLoading: Bool

    public init(beforeCursor: String?, hasMore: Bool, isLoading: Bool = false) {
        self.beforeCursor = beforeCursor
        self.hasMore = hasMore
        self.isLoading = isLoading
    }
}

/// The small rendered-message delta produced by the native thread stream.
/// Keeping this beside the authoritative detail lets recycled transcript rows
/// update in proportion to an event instead of rescanning the full history.
public struct FeatureDetailDelta: Sendable, Equatable {
    public var changedMessages: [FeatureMessage]
    public var appendedMessageIDs: [String]

    public init(
        changedMessages: [FeatureMessage],
        appendedMessageIDs: [String] = []
    ) {
        self.changedMessages = changedMessages
        self.appendedMessageIDs = appendedMessageIDs
    }
}

public struct FeatureModel: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var detail: String?
    public var supportsImages: Bool
    public var supportsReasoning: Bool
    public var isDefault: Bool
    public var isLegacy: Bool?
    public var options: [FeatureModelOptionDescriptor]

    public init(
        id: String,
        name: String,
        detail: String? = nil,
        supportsImages: Bool = false,
        supportsReasoning: Bool = false,
        isDefault: Bool = false,
        isLegacy: Bool? = nil,
        options: [FeatureModelOptionDescriptor] = []
    ) {
        self.id = id
        self.name = name
        self.detail = detail
        self.supportsImages = supportsImages
        self.supportsReasoning = supportsReasoning
        self.isDefault = isDefault
        self.isLegacy = isLegacy
        self.options = options
    }
}

public enum FeatureModelOptionKind: String, Sendable, Equatable, Hashable, Codable {
    case select
    case boolean
}

public struct FeatureModelOptionChoice: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var isDefault: Bool

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.isDefault = isDefault
    }
}

public struct FeatureModelOptionDescriptor: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var label: String
    public var detail: String?
    public var kind: FeatureModelOptionKind
    public var choices: [FeatureModelOptionChoice]
    public var defaultValue: FeatureModelOptionValue?

    public init(
        id: String,
        label: String,
        detail: String? = nil,
        kind: FeatureModelOptionKind,
        choices: [FeatureModelOptionChoice] = [],
        defaultValue: FeatureModelOptionValue? = nil
    ) {
        self.id = id
        self.label = label
        self.detail = detail
        self.kind = kind
        self.choices = choices
        self.defaultValue = defaultValue
    }
}

public enum FeatureModelOptionValue: Sendable, Equatable, Hashable, Codable {
    case string(String)
    case boolean(Bool)

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    private enum ValueType: String, Codable {
        case string
        case boolean
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(ValueType.self, forKey: .type) {
        case .string:
            self = try .string(container.decode(String.self, forKey: .value))
        case .boolean:
            self = try .boolean(container.decode(Bool.self, forKey: .value))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .string(value):
            try container.encode(ValueType.string, forKey: .type)
            try container.encode(value, forKey: .value)
        case let .boolean(value):
            try container.encode(ValueType.boolean, forKey: .type)
            try container.encode(value, forKey: .value)
        }
    }
}

public struct FeatureModelOptionSelection: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var value: FeatureModelOptionValue

    public init(id: String, value: FeatureModelOptionValue) {
        self.id = id
        self.value = value
    }
}

public struct FeatureProvider: Identifiable, Sendable, Equatable, Hashable, Codable {
    public let id: String
    public var name: String
    public var isAvailable: Bool
    public var driver: String
    public var requiresNewThreadForModelChange: Bool
    public var models: [FeatureModel]
    public var slashCommands: [FeatureProviderSlashCommand]?
    public var skills: [FeatureProviderSkill]?

    public init(
        id: String,
        name: String,
        isAvailable: Bool = true,
        driver: String = "",
        requiresNewThreadForModelChange: Bool = false,
        models: [FeatureModel] = [],
        slashCommands: [FeatureProviderSlashCommand] = [],
        skills: [FeatureProviderSkill] = []
    ) {
        self.id = id
        self.name = name
        self.isAvailable = isAvailable
        self.driver = driver
        self.requiresNewThreadForModelChange = requiresNewThreadForModelChange
        self.models = models
        self.slashCommands = slashCommands
        self.skills = skills
    }
}

public struct FeatureSelection: Sendable, Equatable, Hashable, Codable {
    public var providerID: String
    public var modelID: String
    public var options: [FeatureModelOptionSelection]

    public init(
        providerID: String,
        modelID: String,
        options: [FeatureModelOptionSelection] = []
    ) {
        self.providerID = providerID
        self.modelID = modelID
        self.options = options
    }
}

public enum FeatureAppearance: String, CaseIterable, Sendable, Codable {
    case system
    case light
    case dark
}

public struct FeatureSettings: Sendable, Equatable, Codable {
    public var appearance: FeatureAppearance
    public var hapticsEnabled: Bool
    public var notificationsEnabled: Bool
    public var liveActivitiesEnabled: Bool
    /// Web's "Activity detail": a settled turn keeps its tool calls and
    /// reasoning steps expanded instead of folding them away. Off by default so
    /// the transcript stays scannable unless the reader asks for the detail.
    public var alwaysExpandActivity: Bool
    public var defaultSelection: FeatureSelection?

    public init(
        appearance: FeatureAppearance = .system,
        hapticsEnabled: Bool = true,
        notificationsEnabled: Bool = true,
        liveActivitiesEnabled: Bool = true,
        alwaysExpandActivity: Bool = false,
        defaultSelection: FeatureSelection? = nil
    ) {
        self.appearance = appearance
        self.hapticsEnabled = hapticsEnabled
        self.notificationsEnabled = notificationsEnabled
        self.liveActivitiesEnabled = liveActivitiesEnabled
        self.alwaysExpandActivity = alwaysExpandActivity
        self.defaultSelection = defaultSelection
    }

    private enum CodingKeys: String, CodingKey {
        case appearance
        case hapticsEnabled
        case notificationsEnabled
        case liveActivitiesEnabled
        case alwaysExpandActivity
        case defaultSelection
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        appearance = try container.decodeIfPresent(
            FeatureAppearance.self,
            forKey: .appearance
        ) ?? .system
        hapticsEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .hapticsEnabled
        ) ?? true
        notificationsEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .notificationsEnabled
        ) ?? true
        liveActivitiesEnabled = try container.decodeIfPresent(
            Bool.self,
            forKey: .liveActivitiesEnabled
        ) ?? true
        alwaysExpandActivity = try container.decodeIfPresent(
            Bool.self,
            forKey: .alwaysExpandActivity
        ) ?? false
        defaultSelection = try container.decodeIfPresent(
            FeatureSelection.self,
            forKey: .defaultSelection
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(appearance, forKey: .appearance)
        try container.encode(hapticsEnabled, forKey: .hapticsEnabled)
        try container.encode(notificationsEnabled, forKey: .notificationsEnabled)
        try container.encode(liveActivitiesEnabled, forKey: .liveActivitiesEnabled)
        try container.encode(alwaysExpandActivity, forKey: .alwaysExpandActivity)
        try container.encodeIfPresent(defaultSelection, forKey: .defaultSelection)
    }
}

public struct FeatureEnvironmentPreferences: Sendable, Equatable, Codable {
    public var defaultWorkspaceMode: FeatureWorkspaceMode
    public var newWorktreesStartFromOrigin: Bool

    public init(
        defaultWorkspaceMode: FeatureWorkspaceMode = .local,
        newWorktreesStartFromOrigin: Bool = true
    ) {
        self.defaultWorkspaceMode = defaultWorkspaceMode
        self.newWorktreesStartFromOrigin = newWorktreesStartFromOrigin
    }
}

public struct FeatureSnapshot: Sendable, Equatable, Codable {
    public var connection: FeatureConnection
    public var environments: [FeatureEnvironment]
    public var projects: [FeatureProject]
    public var threads: [FeatureThread]
    public var providers: [FeatureProvider]
    /// Provider catalogues are environment-scoped. `providers` remains the
    /// active environment's catalogue for source-compatible consumers.
    public var providersByEnvironment: [String: [FeatureProvider]]?
    /// Server-authoritative new-thread defaults keyed by saved environment.
    public var preferencesByEnvironment: [String: FeatureEnvironmentPreferences]?
    public var settings: FeatureSettings

    public init(
        connection: FeatureConnection = .init(),
        environments: [FeatureEnvironment] = [],
        projects: [FeatureProject] = [],
        threads: [FeatureThread] = [],
        providers: [FeatureProvider] = [],
        providersByEnvironment: [String: [FeatureProvider]]? = nil,
        preferencesByEnvironment: [String: FeatureEnvironmentPreferences]? = nil,
        settings: FeatureSettings = .init()
    ) {
        self.connection = connection
        self.environments = environments
        self.projects = projects
        self.threads = threads
        self.providers = providers
        self.providersByEnvironment = providersByEnvironment
        self.preferencesByEnvironment = preferencesByEnvironment
        self.settings = settings
    }
}

public enum FeatureApprovalDecision: String, Sendable, Codable {
    case allowOnce
    case allowForSession
    case deny
}

public enum FeatureEvent: Sendable {
    case snapshot(FeatureSnapshot)
    case connection(FeatureConnection)
    case thread(FeatureThread)
    case threadRemoved(id: String)
    case detail(FeatureThreadDetail)
    case detailDelta(FeatureThreadDetail, FeatureDetailDelta)
    case failure(String)
}
