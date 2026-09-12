import Foundation

public struct NativeServerUpdateResult: Codable, Equatable, Sendable {
    public let targetVersion: String
    public let method: String
    public let updateId: String?
    public let desktopUpdateToken: String?
}

struct NativeServerUpdateProgress: Decodable, Sendable {
    let type: String
    let stage: String?
    let result: NativeServerUpdateResult?
}

struct NativeServerUpdateReady: Decodable, Sendable {
    struct Payload: Decodable, Sendable {
        struct Environment: Decodable, Sendable { let serverVersion: String }
        let environment: Environment
    }
    let type: String
    let payload: Payload?
    private enum CodingKeys: String, CodingKey { case type, payload }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        payload = type == "ready" ? try container.decode(Payload.self, forKey: .payload) : nil
    }
}

enum NativeDesktopUpdateHandoff {
    static func run(
        prepared: NativeServerUpdateResult,
        events: AsyncThrowingStream<NativeServerUpdateReady, Error>,
        commit: @Sendable () async throws -> Void
    ) async throws -> String {
        var iterator = events.makeAsyncIterator()
        var initialReady = false
        while let event = try await iterator.next() {
            if event.type == "ready" { initialReady = true; break }
        }
        guard initialReady else { throw RPCError.disconnected }
        for _ in 0..<3 {
            try Task.checkCancellation()
            do {
                try await commit()
            } catch RPCError.disconnected {
                // Installing closes the bundled server's socket.
            } catch RPCError.connectionUnavailable {
                // Retry a lost commit after the next ready event.
            }
            var reconnected = false
            while let event = try await iterator.next() {
                guard event.type == "ready" else { continue }
                reconnected = true
                if event.payload?.environment.serverVersion == prepared.targetVersion { return prepared.targetVersion }
                break
            }
            guard reconnected else { throw RPCError.disconnected }
        }
        throw RPCError.remote("The desktop app reconnected without installing the prepared version.")
    }
}
