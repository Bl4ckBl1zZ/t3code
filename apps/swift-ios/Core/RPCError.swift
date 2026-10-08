import Foundation

public enum RPCError: LocalizedError, Sendable {
    case connectionUnavailable
    case disconnected
    case responseTimedOut
    case remote(String)
    case protocolViolation(String)
    /// The server does not know the method: it predates the feature.
    case unsupportedMethod(String)

    public var errorDescription: String? {
        switch self {
        case .connectionUnavailable:
            "The live command connection is unavailable."
        case .disconnected: "The environment disconnected."
        case .responseTimedOut: "The environment did not answer the command in time."
        case let .remote(message): message
        case let .protocolViolation(message): message
        case .unsupportedMethod: "This server does not support this yet. Update T3 Code on the server."
        }
    }
}

