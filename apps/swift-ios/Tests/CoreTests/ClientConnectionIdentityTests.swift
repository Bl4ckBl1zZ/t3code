import XCTest
@testable import T3Code

@MainActor
final class ClientConnectionIdentityTests: XCTestCase {
    func testQueryItemsCarryEveryFieldTheServerReads() {
        let identity = ClientConnectionIdentity(
            appVersion: "0.0.34",
            osMajorVersion: 27,
            deviceModel: "iPhone17,2"
        )

        XCTAssertEqual(
            queryDictionary(identity.queryItems),
            [
                "clientSurface": "mobile",
                "clientAppVersion": "0.0.34",
                "clientOs": "iOS",
                "clientOsMajorVersion": "27",
                "clientDeviceModel": "iPhone17,2",
            ]
        )
    }

    func testQueryItemsOmitFieldsTheServerWouldDiscard() {
        // The server drops absent, empty, and non-positive values; sending them
        // would only make the upgrade URL longer.
        let identity = ClientConnectionIdentity(
            appVersion: "",
            osMajorVersion: 0,
            deviceModel: nil
        )

        XCTAssertEqual(
            queryDictionary(identity.queryItems),
            ["clientSurface": "mobile", "clientOs": "iOS"]
        )
    }

    func testQueryItemNamesCoverEveryItemProduced() {
        // Guards the removeAll in T3Client: a new field that is not listed here
        // would accumulate duplicates across reconnects.
        let produced = Set(ClientConnectionIdentity.current.queryItems.map(\.name))
        XCTAssertTrue(produced.isSubset(of: ClientConnectionIdentity.queryItemNames))
    }

    func testCurrentIdentityReportsTheRunningDevice() {
        let identity = ClientConnectionIdentity.current
        // Foundation always answers this, so an absent value means the accessor
        // regressed rather than the platform declining to say.
        XCTAssertNotNil(identity.osMajorVersion)
        XCTAssertGreaterThan(identity.osMajorVersion ?? 0, 0)
        // On a Simulator this is SIMULATOR_MODEL_IDENTIFIER rather than the
        // host's "arm64"; either way it must be present and within the cap.
        let model = try? XCTUnwrap(identity.deviceModel)
        XCTAssertFalse(model?.isEmpty ?? true)
        XCTAssertLessThanOrEqual(model?.count ?? .max, 80)
    }

    func testConnectionURLCarriesTheIdentityAlongsideTheTicket() async throws {
        let environment = Environment(
            id: "environment-1",
            label: "Studio",
            httpBaseURL: URL(string: "https://studio.example")!,
            // A stale surface on the stored base URL must not survive: the
            // pairing URL is user-supplied and reconnects reuse it.
            webSocketBaseURL: URL(string: "wss://studio.example/ws?clientSurface=web")!
        )
        let credentials = InMemoryCredentialStore(
            credentials: [
                environment.id: EnvironmentCredential(accessToken: "access-token"),
            ]
        )
        let transport = RecordingTicketTransport()
        let connector = URLRecordingWebSocketConnector()
        let client = T3Client(
            environment: environment,
            credentialStore: credentials,
            httpTransport: transport,
            webSocketConnector: connector,
            connectionIdentity: ClientConnectionIdentity(
                appVersion: "0.0.34",
                osMajorVersion: 27,
                deviceModel: "iPhone17,2"
            )
        )

        await client.connect()
        let recorded = await connector.firstURL()
        await client.disconnect()
        let url = try XCTUnwrap(recorded)

        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let query = queryDictionary(items)
        XCTAssertEqual(query["wsTicket"], "websocket-ticket")
        XCTAssertEqual(query["clientSurface"], "mobile")
        XCTAssertEqual(query["clientAppVersion"], "0.0.34")
        XCTAssertEqual(query["clientOs"], "iOS")
        XCTAssertEqual(query["clientOsMajorVersion"], "27")
        XCTAssertEqual(query["clientDeviceModel"], "iPhone17,2")
        XCTAssertEqual(items.filter { $0.name == "clientSurface" }.count, 1)
    }

    private func queryDictionary(_ items: [URLQueryItem]) -> [String: String] {
        items.reduce(into: [:]) { result, item in result[item.name] = item.value ?? "" }
    }
}

private actor RecordingTicketTransport: HTTPTransport {
    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let body = """
        {"ticket": "websocket-ticket", "expiresAt": "2026-08-30T12:05:00.000Z"}
        """
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), response)
    }
}

private actor URLRecordingWebSocketConnector: WebSocketConnecting {
    private var urls: [URL] = []
    private var waiter: CheckedContinuation<URL, Never>?

    func connect(to url: URL) async throws -> any WebSocketConnection {
        urls.append(url)
        waiter?.resume(returning: url)
        waiter = nil
        return IdleWebSocketConnection()
    }

    func firstURL() async -> URL? {
        if let first = urls.first { return first }
        return await withCheckedContinuation { continuation in
            waiter = continuation
        }
    }
}

private actor IdleWebSocketConnection: WebSocketConnection {
    private var receiver: CheckedContinuation<Data, Error>?

    func send(_: Data) throws {}

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            receiver = continuation
        }
    }

    func close() {
        receiver?.resume(throwing: CancellationError())
        receiver = nil
    }
}
