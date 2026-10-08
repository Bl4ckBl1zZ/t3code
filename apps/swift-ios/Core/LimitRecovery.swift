import Foundation

/// `OrchestrationV2LimitRecovery`: the user's choice about continuing a thread
/// the provider stopped on a usage limit. A choice belongs to one run and one
/// reset time; a newer limit stop starts with no choice made.
public struct OrchestrationV2LimitRecovery: Codable, Equatable, Sendable {
    public var requestId: String? = nil
    public let runId: String
    public let resetAt: OrchestrationV2Timestamp
    public let autoResume: Bool
    public var snooze: Bool? = nil

    public init(
        requestId: String? = nil,
        runId: String,
        resetAt: OrchestrationV2Timestamp,
        autoResume: Bool,
        snooze: Bool? = nil
    ) {
        self.requestId = requestId
        self.runId = runId
        self.resetAt = resetAt
        self.autoResume = autoResume
        self.snooze = snooze
    }

    private enum CodingKeys: String, CodingKey {
        case requestId, runId, resetAt, autoResume, snooze
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try container.decodeIfPresent(String.self, forKey: .requestId)
        runId = try container.decode(String.self, forKey: .runId)
        resetAt = try container.decode(String.self, forKey: .resetAt)
        autoResume = try container.decodeIfPresent(Bool.self, forKey: .autoResume) ?? false
        snooze = try container.decodeIfPresent(Bool.self, forKey: .snooze)
    }
}

extension OrchestrationCommands {
    /// `thread.metadata.update` with `limitRecovery`. Omitted options keep
    /// their value for the same run and reset, so each toggle sends only
    /// itself.
    public static func updateLimitRecovery(
        threadID: String,
        runID: String,
        resetAt: OrchestrationV2Timestamp,
        autoResume: Bool? = nil,
        snooze: Bool? = nil,
        commandID: String = UUID().uuidString
    ) -> JSONValue {
        var recovery: [String: JSONValue] = [
            "runId": .string(runID),
            "resetAt": .string(resetAt),
        ]
        if let autoResume { recovery["autoResume"] = .bool(autoResume) }
        if let snooze { recovery["snooze"] = .bool(snooze) }
        return updateMetadata(
            threadID: threadID,
            commandID: commandID,
            fields: ["limitRecovery": .object(recovery)]
        )
    }
}
