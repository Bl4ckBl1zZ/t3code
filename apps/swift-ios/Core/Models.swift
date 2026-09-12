import Foundation

public enum EnvironmentKind: String, Codable, Sendable {
    case bearer
    case local
    case managedDPoP = "managed-dpop"
}

public struct Environment: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public var label: String
    public var httpBaseURL: URL
    public var webSocketBaseURL: URL
    public var kind: EnvironmentKind
    public var descriptor: EnvironmentDescriptor?

    public init(
        id: String,
        label: String,
        httpBaseURL: URL,
        webSocketBaseURL: URL,
        kind: EnvironmentKind = .bearer,
        descriptor: EnvironmentDescriptor? = nil
    ) {
        self.id = id
        self.label = label
        self.httpBaseURL = httpBaseURL
        self.webSocketBaseURL = webSocketBaseURL
        self.kind = kind
        self.descriptor = descriptor
    }
}

public struct EnvironmentDescriptor: Codable, Equatable, Sendable {
    public struct Platform: Codable, Equatable, Sendable {
        public let os: String
        public let arch: String
        public var machine: String? = nil
    }

    public struct Capabilities: Codable, Equatable, Sendable {
        public let repositoryIdentity: Bool
        public let connectionProbe: Bool?
        public let threadSettlement: Bool?
        public var threadRestartContinuation: Bool? = nil
        public var threadAutoSettlement: Bool? = nil
        public let threadSnooze: Bool?
        public let threadPinning: Bool?
        public let threadActiveOrderV2: Bool?
        public let threadQuestionActionsV2: Bool?
        public let threadTitleRegeneration: Bool?
        /// Whether `thread.metadata.update` persists a pull request reference.
        /// Absent on older servers, so the link action stays hidden rather than
        /// sending a command the server will reject.
        public let threadPullRequestLinking: Bool?
        public let threadPullRequestsV2: Bool?
        public struct FileAttachments: Codable, Equatable, Sendable { public let maxUploadBytes: Int }
        public let attachmentUploads: Bool?
        public let fileAttachments: FileAttachments?
        public let assistantCitations: Bool?
        public let customModelDefinitions: Bool?
        public let projectActionDefaults: Bool?
        public let projectDefaults: Bool?
        public let projectBrowserAccess: Bool?
        public let projectAutoPull: Bool?
        public let fileDocumentPreviews: Bool?
        public let agentSessionImport: Bool?
        public let providerTerminalEnvironment: Bool?
        public let projectIcons: Bool?
        public let environmentIcon: Bool?
        public let usageLimitSources: Bool?
        public let usagePriceOverrides: Bool?
        public let pullRequestStackActions: Bool?
        public let pullRequests: Bool?
        public let serverSelfUpdate: String?
        public let serverSelfUpdateProgress: Bool?
        public let desktopAppUpdate: Bool?

        private enum CodingKeys: String, CodingKey {
            case repositoryIdentity
            case connectionProbe
            case threadRestartContinuation
            case threadAutoSettlement
            case threadSettlement
            case threadSnooze
            case threadPinning, threadActiveOrderV2, threadQuestionActionsV2
            case threadTitleRegeneration
            case threadPullRequestLinking
            case threadPullRequestsV2
            case attachmentUploads, fileAttachments
            case assistantCitations
            case projectActionDefaults
            case projectDefaults
            case projectBrowserAccess
            case projectAutoPull
            case fileDocumentPreviews
            case agentSessionImport, providerTerminalEnvironment
            case projectIcons
            case customModelDefinitions
            case environmentIcon
            case usageLimitSources
            case usagePriceOverrides
            case pullRequestStackActions
            case pullRequests
            case serverSelfUpdate
            case serverSelfUpdateProgress, desktopAppUpdate
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            repositoryIdentity =
                try container.decodeIfPresent(Bool.self, forKey: .repositoryIdentity) ?? false
            connectionProbe = try container.decodeIfPresent(Bool.self, forKey: .connectionProbe)
            threadRestartContinuation = try container.decodeIfPresent(Bool.self, forKey: .threadRestartContinuation)
            threadAutoSettlement = try container.decodeIfPresent(Bool.self, forKey: .threadAutoSettlement)
            threadSettlement = try container.decodeIfPresent(Bool.self, forKey: .threadSettlement)
            threadSnooze = try container.decodeIfPresent(Bool.self, forKey: .threadSnooze)
            threadPinning = try container.decodeIfPresent(Bool.self, forKey: .threadPinning)
            threadQuestionActionsV2 = try container.decodeIfPresent(Bool.self, forKey: .threadQuestionActionsV2)
            threadActiveOrderV2 = try container.decodeIfPresent(Bool.self, forKey: .threadActiveOrderV2)
            threadTitleRegeneration = try container.decodeIfPresent(
                Bool.self,
                forKey: .threadTitleRegeneration
            )
            threadPullRequestsV2 = try container.decodeIfPresent(Bool.self, forKey: .threadPullRequestsV2)
            attachmentUploads = try container.decodeIfPresent(Bool.self, forKey: .attachmentUploads)
            fileAttachments = try container.decodeIfPresent(FileAttachments.self, forKey: .fileAttachments)
            assistantCitations = try container.decodeIfPresent(Bool.self, forKey: .assistantCitations)
            projectActionDefaults = try container.decodeIfPresent(Bool.self, forKey: .projectActionDefaults)
            projectDefaults = try container.decodeIfPresent(Bool.self, forKey: .projectDefaults)
            projectBrowserAccess = try container.decodeIfPresent(Bool.self, forKey: .projectBrowserAccess)
            projectAutoPull = try container.decodeIfPresent(Bool.self, forKey: .projectAutoPull)
            fileDocumentPreviews = try container.decodeIfPresent(Bool.self, forKey: .fileDocumentPreviews)
            agentSessionImport = try container.decodeIfPresent(Bool.self, forKey: .agentSessionImport)
            providerTerminalEnvironment = try container.decodeIfPresent(Bool.self, forKey: .providerTerminalEnvironment)
            projectIcons = try container.decodeIfPresent(Bool.self, forKey: .projectIcons)
            customModelDefinitions = try container.decodeIfPresent(Bool.self, forKey: .customModelDefinitions)
            environmentIcon = try container.decodeIfPresent(Bool.self, forKey: .environmentIcon)
            usageLimitSources = try container.decodeIfPresent(Bool.self, forKey: .usageLimitSources)
            usagePriceOverrides = try container.decodeIfPresent(Bool.self, forKey: .usagePriceOverrides)
            pullRequestStackActions = try container.decodeIfPresent(Bool.self, forKey: .pullRequestStackActions)
            threadPullRequestLinking = try container.decodeIfPresent(
                Bool.self,
                forKey: .threadPullRequestLinking
            )
            pullRequests = try container.decodeIfPresent(Bool.self, forKey: .pullRequests)
            desktopAppUpdate = try container.decodeIfPresent(Bool.self, forKey: .desktopAppUpdate)
            serverSelfUpdate = try container.decodeIfPresent(String.self, forKey: .serverSelfUpdate)
            serverSelfUpdateProgress = try container.decodeIfPresent(
                Bool.self,
                forKey: .serverSelfUpdateProgress
            )
        }
    }

    public let environmentId: String
    public let label: String
    public let platform: Platform
    public let serverVersion: String
    public let capabilities: Capabilities
}

public enum EnvironmentCredentialAuthorizationMethod: String, Codable, Sendable {
    case bearer
    case dpop
}

public struct EnvironmentCredential: Codable, Equatable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    public let accessToken: String
    public let expiresAt: Date?
    public let scopes: [String]
    public let authorizationMethod: EnvironmentCredentialAuthorizationMethod
    public let managedEnvironmentID: String?
    public let proofKeyThumbprint: String?

    public init(accessToken: String, expiresAt: Date? = nil, scopes: [String] = []) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        authorizationMethod = .bearer
        managedEnvironmentID = nil
        proofKeyThumbprint = nil
    }

    public static func managedDPoP(
        accessToken: String,
        expiresAt: Date,
        scopes: [String],
        environmentID: String,
        proofKeyThumbprint: String
    ) -> EnvironmentCredential {
        EnvironmentCredential(
            accessToken: accessToken,
            expiresAt: expiresAt,
            scopes: scopes,
            authorizationMethod: .dpop,
            managedEnvironmentID: environmentID,
            proofKeyThumbprint: proofKeyThumbprint
        )
    }

    public var description: String {
        "EnvironmentCredential(method: \(authorizationMethod.rawValue), token: <redacted>)"
    }

    public var debugDescription: String { description }

    private init(
        accessToken: String,
        expiresAt: Date?,
        scopes: [String],
        authorizationMethod: EnvironmentCredentialAuthorizationMethod,
        managedEnvironmentID: String?,
        proofKeyThumbprint: String?
    ) {
        self.accessToken = accessToken
        self.expiresAt = expiresAt
        self.scopes = scopes
        self.authorizationMethod = authorizationMethod
        self.managedEnvironmentID = managedEnvironmentID
        self.proofKeyThumbprint = proofKeyThumbprint
    }

    private enum CodingKeys: String, CodingKey {
        case accessToken
        case expiresAt
        case scopes
        case authorizationMethod
        case managedEnvironmentID
        case proofKeyThumbprint
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try container.decode(String.self, forKey: .accessToken)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        scopes = try container.decodeIfPresent([String].self, forKey: .scopes) ?? []
        authorizationMethod = try container.decodeIfPresent(
            EnvironmentCredentialAuthorizationMethod.self,
            forKey: .authorizationMethod
        ) ?? .bearer
        managedEnvironmentID = try container.decodeIfPresent(
            String.self,
            forKey: .managedEnvironmentID
        )
        proofKeyThumbprint = try container.decodeIfPresent(
            String.self,
            forKey: .proofKeyThumbprint
        )

        if authorizationMethod == .dpop {
            guard expiresAt != nil,
                  managedEnvironmentID?.isEmpty == false,
                  proofKeyThumbprint?.isEmpty == false else {
                throw DecodingError.dataCorruptedError(
                    forKey: .authorizationMethod,
                    in: container,
                    debugDescription: "A DPoP credential is missing its binding metadata."
                )
            }
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(accessToken, forKey: .accessToken)
        try container.encodeIfPresent(expiresAt, forKey: .expiresAt)
        try container.encode(scopes, forKey: .scopes)
        try container.encode(authorizationMethod, forKey: .authorizationMethod)
        try container.encodeIfPresent(managedEnvironmentID, forKey: .managedEnvironmentID)
        try container.encodeIfPresent(proofKeyThumbprint, forKey: .proofKeyThumbprint)
    }
}

public struct ModelSelection: Codable, Equatable, Sendable {
    public struct OptionSelection: Codable, Equatable, Sendable {
        public let id: String
        public let value: JSONValue

        public init(id: String, value: JSONValue) {
            self.id = id
            self.value = value
        }
    }

    public let instanceId: String
    public let model: String
    public let options: [OptionSelection]?

    public init(instanceId: String, model: String, options: [OptionSelection]? = nil) {
        self.instanceId = instanceId
        self.model = model
        self.options = options
    }

    private enum CodingKeys: String, CodingKey {
        case instanceId, provider, model, options
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        instanceId = try container.decodeIfPresent(String.self, forKey: .instanceId)
            ?? container.decode(String.self, forKey: .provider)
        model = try container.decode(String.self, forKey: .model)
        if let canonical = try? container.decode([OptionSelection].self, forKey: .options) {
            options = canonical
        } else if let legacy = try? container.decode(
            [String: JSONValue].self,
            forKey: .options
        ) {
            options = legacy.keys.sorted().map { OptionSelection(id: $0, value: legacy[$0]!) }
        } else {
            options = nil
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(instanceId, forKey: .instanceId)
        try container.encode(model, forKey: .model)
        try container.encodeIfPresent(options, forKey: .options)
    }
}

public struct RepositoryIdentity: Codable, Equatable, Sendable {
    public struct Locator: Codable, Equatable, Sendable {
        public let source: String
        public let remoteName: String
        public let remoteUrl: String
    }

    public let canonicalKey: String
    public let locator: Locator
    public let rootPath: String?
    public let displayName: String?
    public let provider: String?
    public let owner: String?
    public let name: String?
}

public struct ProjectScript: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let command: String
    public let icon: String
    public let runOnWorktreeCreate: Bool
    public let runOnWorktreeDelete: Bool?
    public let previewUrl: String?
    public let autoOpenPreview: Bool?
    public let singleRun: Bool?

    public init(id: String, name: String, command: String, icon: String, runOnWorktreeCreate: Bool, runOnWorktreeDelete: Bool? = nil, previewUrl: String? = nil, autoOpenPreview: Bool? = nil, singleRun: Bool? = nil) {
        self.id = id; self.name = name; self.command = command; self.icon = icon
        self.runOnWorktreeCreate = runOnWorktreeCreate; self.runOnWorktreeDelete = runOnWorktreeDelete
        self.previewUrl = previewUrl; self.autoOpenPreview = autoOpenPreview; self.singleRun = singleRun
    }

    public var json: JSONValue {
        var fields: [String: JSONValue] = ["id": .string(id), "name": .string(name), "command": .string(command), "icon": .string(icon), "runOnWorktreeCreate": .bool(runOnWorktreeCreate)]
        if let runOnWorktreeDelete { fields["runOnWorktreeDelete"] = .bool(runOnWorktreeDelete) }
        if let previewUrl { fields["previewUrl"] = .string(previewUrl) }
        if let autoOpenPreview { fields["autoOpenPreview"] = .bool(autoOpenPreview) }
        if let singleRun { fields["singleRun"] = .bool(singleRun) }
        return .object(fields)
    }
}

public struct OrchestrationProject: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let workspaceRoot: String
    public let repositoryIdentity: RepositoryIdentity?
    public let defaultModelSelection: ModelSelection?
    /// A manually chosen project icon, workspace-relative. Absent on servers
    /// predating manual icons and on projects that rely on auto-discovery.
    public let faviconPath: String?
    public var projectIcon: ProjectIconOverride? = nil
    public let scripts: [ProjectScript]
    public let createdAt: String
    public let updatedAt: String
    public let deletedAt: String?
}

public enum RuntimeMode: String, Codable, CaseIterable, Sendable {
    case approvalRequired = "approval-required"
    case autoAcceptEdits = "auto-accept-edits"
    case auto
    case fullAccess = "full-access"
}

public enum InteractionMode: String, Codable, CaseIterable, Sendable {
    case `default`
    case plan
}





public struct ChatAttachment: Codable, Identifiable, Equatable, Sendable {
    public var source: SnapShotSource? = nil
    public let type: String
    public let id: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
}
