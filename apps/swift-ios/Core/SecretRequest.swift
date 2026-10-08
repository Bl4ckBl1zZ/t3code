import Foundation

// Mirrors `packages/contracts/src/secretRequest.ts` and the `secret_request`
// turn item in `orchestrationV2.ts`. An agent asks with `request_secret`; the
// user answers over `secrets.answerRequest`, and the server keeps the value
// under a one-use ref the agent can pass on but never read.

public enum OrchestrationV2SecretRequestStatus: String, Codable, Equatable, Sendable {
    case pending
    case saved
    case declined
    case cancelled
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = OrchestrationV2SecretRequestStatus(rawValue: raw) ?? .unknown
    }
}

/// The user's answer. The value is trimmed and dropped once it is on the wire;
/// it is never persisted, logged or echoed back.
public enum SecretRequestAnswer: Equatable, Sendable {
    case save(String)
    case decline

    /// Nil for a blank save, which the server rejects; callers keep Save
    /// disabled instead.
    public var jsonValue: JSONValue? {
        switch self {
        case let .save(secret):
            let trimmed = secret.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return .object(["type": .string("save"), "secret": .string(trimmed)])
        case .decline:
            return .object(["type": .string("decline")])
        }
    }
}

/// `SecretRequestError`'s reasons, worded as the contract words them. The wire
/// carries only the reason, so the client owns the copy.
public enum SecretRequestFailure {
    static let messages: [String: String] = [
        "load_failed": "Could not load the secret request.",
        "not_found": "This secret request no longer exists.",
        "already_answered": "This secret request was already answered.",
        "agent_stopped": "The agent that asked has stopped, so this secret can't be used.",
        "store_failed": "Could not store the secret.",
        "record_failed": "Saved the secret, but could not update the request.",
        "invalid_ref": "That secretRef is not valid.",
        "read_failed": "Could not read the secret.",
        "ref_unavailable": "That secretRef was already used or does not exist. Ask the user again with request_secret.",
        "ref_expired": "That secretRef expired. Ask the user again with request_secret.",
        "consume_failed": "Could not use that secretRef. Try again.",
    ]

    public static let generic = "Could not answer the request. Try again."

    public static func message(for reason: String) -> String {
        messages[reason] ?? generic
    }

    /// Inline copy for a failed answer. Only the contract's own messages and a
    /// missing permission pass through; anything else (transport, decoding)
    /// gets the generic copy, so no server text that might quote the request
    /// can reach the screen.
    public static func userMessage(for error: any Error) -> String {
        if let required = error as? AuthPermissionRequired, let description = required.errorDescription {
            return description
        }
        if case let RPCError.remote(message) = error, messages.values.contains(message) {
            return message
        }
        if case RPCError.unsupportedMethod = error {
            return RPCError.unsupportedMethod("").errorDescription ?? generic
        }
        if error is SecretRequestPermissionMissing {
            return SecretRequestPermissionMissing.message
        }
        return generic
    }
}

/// The connection is paired without permission to operate threads, which is
/// what answering a request takes.
public struct SecretRequestPermissionMissing: LocalizedError, Equatable, Sendable {
    public static let message = "This device can't answer agent requests on this server. Pair it again with a link that can operate threads."

    public init() {}

    public var errorDescription: String? { Self.message }
}
