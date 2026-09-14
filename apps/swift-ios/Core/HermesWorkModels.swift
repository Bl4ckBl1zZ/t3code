import Foundation

/// Mirrors the environment-scoped Hermes management contract.
public struct HermesWorkConnection: Decodable, Sendable, Identifiable {
    public let providerInstanceId: String
    public let displayName: String
    public let configured: Bool
    public var id: String { providerInstanceId }
}
public struct HermesWorkConnections: Decodable, Sendable {
    public let connections: [HermesWorkConnection]
}
public struct HermesWorkProfile: Decodable, Sendable, Identifiable {
    public let name: String
    public let description: String
    public let model: String
    public let isDefault: Bool
    public var id: String { name }
}
public struct HermesWorkSchedule: Decodable, Sendable, Identifiable {
    public let id: String
    public let profile: String
    public let name: String
    public let prompt: String
    public let schedule: String
    public let paused: Bool
    public let deliver: String
    public let model: String?
    public let nextRunAt: String?
    public let lastRunAt: String?
    public let lastStatus: String?
    public let lastError: String?
    public let continuity: Bool?
    public let lastDeliveryError: String?
}
public struct HermesWorkRun: Decodable, Sendable, Identifiable {
    public let id: String
    public let profile: String
    public let title: String
    public let startedAt: Double?
    public let endedAt: Double?
    public let active: Bool
    public let jobId: String?
    public let status: String?
    public let deliveryStatus: String?
    public let content: String?
    public let readAt: String?
}
public struct HermesWorkSkill: Decodable, Sendable, Identifiable {
    public let name: String
    public let description: String
    public let enabled: Bool
    public var id: String { name }
}
public struct HermesWorkChannel: Decodable, Sendable, Identifiable {
    public struct Field: Decodable, Sendable, Identifiable {
        public let name: String
        public let label: String
        public let secret: Bool
        public let configured: Bool
        public var id: String { name }
    }
    public let id: String
    public let name: String
    public let description: String
    public let enabled: Bool
    public let configured: Bool
    public let fields: [Field]
}
public struct HermesWorkFile: Decodable, Sendable, Identifiable {
    public let name: String
    public let path: String
    public let directory: Bool
    public let size: Double?
    public var id: String { path }
}
public struct HermesWorkQueryResult: Decodable, Sendable {
    public let threadDetails: HermesWorkThreadDetails?
    public let artifacts: [HermesWorkArtifact]?
    public let artifactsNextOffset: Double?
    public let automation: HermesWorkAutomation?
    public let sessions: [HermesWorkSession]?
    public let gatewayRunning: Bool?
    public let gatewayState: String?
    public let profiles: [HermesWorkProfile]
    public let schedules: [HermesWorkSchedule]
    public let runs: [HermesWorkRun]
    public let skills: [HermesWorkSkill]
    public let channels: [HermesWorkChannel]
    public let files: [HermesWorkFile]
    public let content: String?
    public let path: String?
    public let diagnostics: [String]
}
public struct HermesWorkMutationResult: Decodable, Sendable {
    public let threadId: String?
    public let message: String
}

@MainActor
public protocol FeatureWorkManaging: AnyObject {
    func workChanges(environmentID: String, instanceID: String) async throws -> AsyncThrowingStream<HermesWorkChange, Error>
    func workModelStatus(environmentID: String, input: JSONValue) async throws -> HermesWorkModelStatus
    func workModelAuthStart(environmentID: String, input: JSONValue) async throws -> HermesWorkModelAuthStart
    func workModelAuthPoll(environmentID: String, input: JSONValue) async throws -> HermesWorkModelAuthPoll
    func workModelAuthCancel(environmentID: String, input: JSONValue) async throws -> HermesWorkModelAuthCancel
    func workModelSet(environmentID: String, input: JSONValue) async throws -> HermesWorkModelSet
    func workSetupStart(environmentID: String, instanceID: String) async throws -> HermesWorkSetupState
    func workSetupStatus(environmentID: String, instanceID: String) async throws -> HermesWorkSetupState
    func workGroupsQuery(environmentID: String, input: JSONValue) async throws -> HermesWorkGroupsResult
    func workGroupsMutate(environmentID: String, input: JSONValue) async throws -> HermesWorkMutationResult
    func workConnections(environmentID: String) async throws -> HermesWorkConnections
    func workQuery(environmentID: String, input: JSONValue) async throws -> HermesWorkQueryResult
    func workMutate(environmentID: String, input: JSONValue) async throws -> HermesWorkMutationResult
}

public struct HermesWorkGroup: Decodable, Sendable, Identifiable {
    public struct Member: Decodable, Sendable, Identifiable {
        public let id: String
        public let profile: String
        public let handle: String
        public let name: String
    }
    public let id: String
    public let name: String
    public let members: [Member]
    public let updatedAt: Double
    public let disbandedAt: Double?
    public let latestSequence: Double
}
public struct HermesWorkGroupEvent: Decodable, Sendable, Identifiable {
    public let id: String
    public let sequence: Double
    public let kind: String
    public let actor: String
    public let text: String
    public let createdAt: Double
}
public struct HermesWorkGroupsResult: Decodable, Sendable {
    public let groups: [HermesWorkGroup]
    public let events: [HermesWorkGroupEvent]
    public let cursor: Double
    public let hasMore: Bool
    public let nextOffset: Double?
}

public struct HermesWorkSession: Decodable, Sendable, Identifiable {
    public let id: String
    public let profile: String
    public let title: String
    public let preview: String
    public let active: Bool
    public let updatedAt: Double?
}

public struct HermesWorkAutomation: Decodable, Sendable {
    public let timezone: String
    public let allowAgentScheduling: Bool
}

public struct HermesWorkArtifact: Decodable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let value: String
    public let label: String
    public let sessionId: String
    public let profile: String
    public let sessionTitle: String
    public let timestamp: Double
}

public struct HermesWorkSetupState: Decodable, Sendable {
    public let providerInstanceId: String
    public let phase: String
    public let message: String
    public let model: String?
    public var isActive: Bool { ["installing", "configuring", "connecting"].contains(phase) }
}

public struct HermesWorkModelStatus: Decodable, Sendable {
    public struct Provider: Decodable, Sendable, Identifiable {
        public let id: String; public let name: String; public let authenticated: Bool; public let models: [String]
    }
    public struct Account: Decodable, Sendable, Identifiable {
        public let id: String; public let name: String; public let flow: String; public let loggedIn: Bool; public let sourceLabel: String?
    }
    public let model: String; public let provider: String; public let ready: Bool
    public let providers: [Provider]; public let accounts: [Account]
}
public struct HermesWorkModelAuthStart: Decodable, Sendable {
    public let sessionId: String; public let userCode: String; public let verificationUrl: String
    public let expiresIn: Double; public let pollInterval: Double
}
public struct HermesWorkModelAuthPoll: Decodable, Sendable {
    public let status: String; public let message: String?
}
public struct HermesWorkModelSet: Decodable, Sendable {
    public let ok: Bool; public let confirmRequired: Bool; public let message: String?
}
public struct HermesWorkModelAuthCancel: Decodable, Sendable { public let ok: Bool }

public struct HermesWorkThreadDetails: Decodable, Sendable {
    public struct LinkedSchedule: Decodable, Sendable, Identifiable {
        public enum Relationship: String, Decodable, Sendable { case createdHere = "created_here"; case runOf = "run_of" }
        public let id: String
        public let profile: String
        public let name: String
        public let prompt: String
        public let schedule: String
        public let paused: Bool
        public let deliver: String
        public let model: String?
        public let nextRunAt: String?
        public let lastRunAt: String?
        public let lastStatus: String?
        public let lastError: String?
        public let continuity: Bool?
        public let lastDeliveryError: String?
        public let relationship: Relationship
    }
    public let threadId: String
    public let status: String
    public let providerInstanceId: String?
    public let profile: String?
    public let sessionId: String?
    public let workspacePath: String?
    public let schedules: [LinkedSchedule]
    public let schedulesAvailable: Bool?
    public let gatewayRunning: Bool?
    public let gatewayState: String?
}

public struct HermesWorkChange: Decodable, Sendable {
    public let providerInstanceId: String
    public let kind: String
}
