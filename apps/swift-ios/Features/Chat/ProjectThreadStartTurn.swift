import Foundation

// Ported from apps/mobile/src/lib/projectThreadStartTurn.ts. Single source of
// the `thread.turn.start` bootstrap payload used to create a thread from a
// project draft, so the immediate send path and the offline outbox drain deliver
// byte-identical commands.

public struct ProjectThreadStartTurnSpec: Equatable, Sendable {
    public enum WorkspaceMode: String, Equatable, Sendable {
        case local
        case worktree
    }

    public let projectID: String
    public let projectCwd: String
    public let threadID: String
    public let commandID: String
    public let messageID: String
    public let createdAt: String
    public let text: String
    public let attachments: [DraftComposerAttachment]
    public let modelSelection: ModelSelection
    public let runtimeMode: RuntimeMode
    public let interactionMode: InteractionMode
    public let workspaceMode: WorkspaceMode
    public let branch: String?
    public let worktreePath: String?
    public let startFromOrigin: Bool
    /// False for conversation providers whose backing project is routing-only.
    /// `nil` leaves the key off the payload entirely, which is what an ordinary
    /// project launch sends.
    public let prepareWorkspace: Bool?
    /// Generated temp branch for worktree mode; unused for local mode.
    public let worktreeBranchName: String

    public init(
        projectID: String,
        projectCwd: String,
        threadID: String,
        commandID: String,
        messageID: String,
        createdAt: String,
        text: String,
        attachments: [DraftComposerAttachment] = [],
        modelSelection: ModelSelection,
        runtimeMode: RuntimeMode,
        interactionMode: InteractionMode = .default,
        workspaceMode: WorkspaceMode = .local,
        branch: String? = nil,
        worktreePath: String? = nil,
        startFromOrigin: Bool = false,
        prepareWorkspace: Bool? = nil,
        worktreeBranchName: String = ""
    ) {
        self.projectID = projectID
        self.projectCwd = projectCwd
        self.threadID = threadID
        self.commandID = commandID
        self.messageID = messageID
        self.createdAt = createdAt
        self.text = text
        self.attachments = attachments
        self.modelSelection = modelSelection
        self.runtimeMode = runtimeMode
        self.interactionMode = interactionMode
        self.workspaceMode = workspaceMode
        self.branch = branch
        self.worktreePath = worktreePath
        self.startFromOrigin = startFromOrigin
        self.prepareWorkspace = prepareWorkspace
        self.worktreeBranchName = worktreeBranchName
    }
}

public enum ProjectThreadStartTurn {
    private static let titleMaximumCharacters = 72
    private static let titleTruncatedCharacters = 69

    /// The title a thread gets before the orchestrator generates a real one, so
    /// a pending row in the list is recognisable while the turn is still in
    /// flight.
    public static func deriveTitle(fromPrompt value: String) -> String {
        let compact = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !compact.isEmpty else { return "New thread" }
        guard compact.count > titleMaximumCharacters else { return compact }
        // Trim again: the cut can land immediately after a space.
        let head = compact.prefix(titleTruncatedCharacters)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(head)..."
    }

    /// Builds the `thread.turn.start` input without its `type` discriminant —
    /// the transport stamps that when it dispatches the command, as it does for
    /// every other `OrchestrationCommands` payload.
    public static func buildInput(_ spec: ProjectThreadStartTurnSpec) throws -> JSONValue {
        let title = deriveTitle(fromPrompt: spec.text)
        let isWorktree = spec.workspaceMode == .worktree
        let modelSelection = try JSONValue.encode(spec.modelSelection)

        let createThread: [String: JSONValue] = [
            "projectId": .string(spec.projectID),
            "title": .string(title),
            "modelSelection": modelSelection,
            "runtimeMode": .string(spec.runtimeMode.rawValue),
            "interactionMode": .string(spec.interactionMode.rawValue),
            "branch": spec.branch.map(JSONValue.string) ?? .null,
            // The server picks the worktree path during bootstrap, so a draft's
            // path must not travel with a worktree launch.
            "worktreePath": isWorktree ? .null : (spec.worktreePath.map(JSONValue.string) ?? .null),
            "createdAt": .string(spec.createdAt),
        ]

        var bootstrap: [String: JSONValue] = ["createThread": .object(createThread)]
        if let prepareWorkspace = spec.prepareWorkspace {
            bootstrap["prepareWorkspace"] = .bool(prepareWorkspace)
        }
        if isWorktree {
            var prepareWorktree: [String: JSONValue] = [
                "projectCwd": .string(spec.projectCwd),
                // A worktree launch cannot be reached without a base branch; a
                // missing one travels as null so the server rejects it rather
                // than branching off whatever happens to be checked out.
                "baseBranch": spec.branch.map(JSONValue.string) ?? .null,
                "branch": .string(spec.worktreeBranchName),
            ]
            if spec.startFromOrigin {
                prepareWorktree["startFromOrigin"] = .bool(true)
            }
            bootstrap["prepareWorktree"] = .object(prepareWorktree)
            bootstrap["runSetupScript"] = .bool(true)
        }

        return .object([
            "commandId": .string(spec.commandID),
            "creationSource": .string("mobile"),
            "threadId": .string(spec.threadID),
            "message": .object([
                "messageId": .string(spec.messageID),
                "role": .string("user"),
                "text": .string(spec.text),
                "attachments": .array(
                    ComposerAttachments.uploadAttachments(spec.attachments).map(\.jsonValue)
                ),
            ]),
            "modelSelection": modelSelection,
            "titleSeed": .string(title),
            "runtimeMode": .string(spec.runtimeMode.rawValue),
            "interactionMode": .string(spec.interactionMode.rawValue),
            "bootstrap": .object(bootstrap),
            "createdAt": .string(spec.createdAt),
        ])
    }
}
