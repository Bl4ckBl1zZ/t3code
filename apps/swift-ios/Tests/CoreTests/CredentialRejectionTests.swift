import Foundation
import XCTest
@testable import T3Code

/// The server closes a socket whose session was revoked, replaced or expired
/// without saying why; the redial's refusal is what marks the credential dead.
final class CredentialRejectionTests: XCTestCase {
    func testRefusalsOfTheCredentialAreRejections() {
        XCTAssertTrue(CredentialRejection.isRejected(
            HTTPError.status(401, message: "The environment rejected this client's credentials (invalid_credential).", traceID: "trace")
        ))
        XCTAssertTrue(CredentialRejection.isRejected(HTTPError.missingCredential))
        XCTAssertTrue(CredentialRejection.isRejected(HTTPError.incompatibleCredential))
        XCTAssertTrue(CredentialRejection.isRejected(
            T3ConnectRelayError.response(status: 403, message: "No access to this environment.", traceID: nil)
        ))
        XCTAssertTrue(CredentialRejection.isRejected(
            T3ConnectRelayError.response(status: 401, message: "Sign in again.", traceID: nil)
        ))
    }

    func testDroppedNetworksAndOtherFailuresAreNot() {
        XCTAssertFalse(CredentialRejection.isRejected(URLError(.networkConnectionLost)))
        XCTAssertFalse(CredentialRejection.isRejected(URLError(.timedOut)))
        XCTAssertFalse(CredentialRejection.isRejected(HTTPError.status(403, message: "Pair this device again.", traceID: nil)))
        XCTAssertFalse(CredentialRejection.isRejected(HTTPError.status(503, message: "Unavailable", traceID: nil)))
        XCTAssertFalse(CredentialRejection.isRejected(HTTPError.managedAuthorizationUnavailable))
        XCTAssertFalse(CredentialRejection.isRejected(RPCError.disconnected))
        XCTAssertFalse(CredentialRejection.isRejected(
            T3ConnectRelayError.response(status: 502, message: "Bad gateway", traceID: nil)
        ))
        XCTAssertFalse(CredentialRejection.isRejected(T3ConnectRelayError.environmentMismatch))
    }

    func testRefusedRedialAfterAServerCloseFailsWaitingRequestsWithTheRefusal() async throws {
        let socket = ServerClosedSocket()
        let dials = RefusingDials()
        let client = WebSocketRPCClient(
            connector: SingleSocketConnector(socket: socket),
            // Long enough that a still-retrying loop would fail the request
            // with `connectionUnavailable` instead.
            connectionWaitTimeout: .seconds(20),
            endpointProvider: { try await dials.next() }
        )

        await client.start()
        await socket.waitUntilReceiving()
        await socket.closeFromServer()
        await dials.waitForCount(2)

        do {
            _ = try await client.request("server.getConfig", as: JSONValue.self)
            XCTFail("A refused credential must fail the request.")
        } catch let HTTPError.status(status, _, _) {
            XCTAssertEqual(status, 401)
        } catch {
            XCTFail("Expected the refusal, got \(error)")
        }
        await client.stop()
    }
}

/// Hands out the endpoint once, then refuses the credential like a ticket
/// mint for a revoked session.
private actor RefusingDials {
    private var count = 0
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func next() throws -> URL {
        count += 1
        let ready = waiters.filter { count >= $0.0 }
        waiters.removeAll { count >= $0.0 }
        ready.forEach { $0.1.resume() }
        guard count == 1 else {
            throw HTTPError.status(
                401,
                message: "The environment rejected this client's credentials (invalid_credential).",
                traceID: nil
            )
        }
        return URL(string: "wss://studio.example/ws")!
    }

    func waitForCount(_ target: Int) async {
        guard count < target else { return }
        await withCheckedContinuation { waiters.append((target, $0)) }
    }
}

private struct SingleSocketConnector: WebSocketConnecting {
    let socket: ServerClosedSocket

    func connect(to _: URL) async throws -> any WebSocketConnection {
        socket
    }
}

/// Stays open until the server closes it, which, like the real close, carries
/// no reason.
private actor ServerClosedSocket: WebSocketConnection {
    private var receiver: CheckedContinuation<Data, Error>?
    private var receivingWaiter: CheckedContinuation<Void, Never>?
    private var closed = false

    func send(_: Data) throws {
        if closed { throw URLError(.networkConnectionLost) }
    }

    func receive() async throws -> Data {
        if closed { throw URLError(.networkConnectionLost) }
        return try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
            receivingWaiter?.resume()
            receivingWaiter = nil
        }
    }

    func close() {
        closeFromServer()
    }

    func closeFromServer() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func waitUntilReceiving() async {
        guard receiver == nil else { return }
        await withCheckedContinuation { receivingWaiter = $0 }
    }
}
