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
    }

    public struct Capabilities: Codable, Equatable, Sendable {
        public let repositoryIdentity: Bool
        public let connectionProbe: Bool?
        public let threadSettlement: Bool?
        public let threadSnooze: Bool?
        public let threadPinning: Bool?
        public let threadTitleRegeneration: Bool?
        public let serverSelfUpdate: String?
        public let serverSelfUpdateProgress: Bool?

        private enum CodingKeys: String, CodingKey {
            case repositoryIdentity
            case connectionProbe
            case threadSettlement
            case threadSnooze
            case threadPinning
            case threadTitleRegeneration
            case serverSelfUpdate
            case serverSelfUpdateProgress
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            repositoryIdentity =
                try container.decodeIfPresent(Bool.self, forKey: .repositoryIdentity) ?? false
            connectionProbe = try container.decodeIfPresent(Bool.self, forKey: .connectionProbe)
            threadSettlement = try container.decodeIfPresent(Bool.self, forKey: .threadSettlement)
            threadSnooze = try container.decodeIfPresent(Bool.self, forKey: .threadSnooze)
            threadPinning = try container.decodeIfPresent(Bool.self, forKey: .threadPinning)
            threadTitleRegeneration = try container.decodeIfPresent(
                Bool.self,
                forKey: .threadTitleRegeneration
            )
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
    public let previewUrl: String?
    public let autoOpenPreview: Bool?
}

public struct OrchestrationProject: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let workspaceRoot: String
    public let repositoryIdentity: RepositoryIdentity?
    public let defaultModelSelection: ModelSelection?
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
    public let type: String
    public let id: String
    public let name: String
    public let mimeType: String
    public let sizeBytes: Int
}
