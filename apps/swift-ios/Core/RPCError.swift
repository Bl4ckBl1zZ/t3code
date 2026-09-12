import Foundation

public enum RPCError: LocalizedError, Sendable {
    case connectionUnavailable
    case disconnected
    case responseTimedOut
    case remote(String)
    case protocolViolation(String)

    public var errorDescription: String? {
        switch self {
        case .connectionUnavailable:
            "The live command connection is unavailable."
        case .disconnected: "The environment disconnected."
        case .responseTimedOut: "The environment did not answer the command in time."
        case let .remote(message): message
        case let .protocolViolation(message): message
        }
    }
}

