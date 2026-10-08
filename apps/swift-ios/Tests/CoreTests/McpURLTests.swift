import Foundation
import Testing
@testable import T3Code

@Suite("MCP URL for outside agents")
struct McpURLTests {
    private func route(_ address: String, kind: EnvironmentKind = .bearer) -> EnvironmentRoute {
        let url = URL(string: address)!
        return .saved(
            httpBaseURL: url,
            webSocketBaseURL: EnvironmentRoutes.webSocketBaseURL(for: url)!,
            kind: kind,
            credentialID: "env"
        )
    }

    @Test func httpsAddressesGetMcpAtTheirRoot() {
        #expect(EnvironmentRoutes.mcpURL([route("https://desk.example:8443/app/?x=1#top")])
            == URL(string: "https://desk.example:8443/mcp"))
    }

    @Test func loopbackHttpQualifies() {
        #expect(EnvironmentRoutes.mcpURL([route("http://localhost:3773/")]) == URL(string: "http://localhost:3773/mcp"))
        #expect(EnvironmentRoutes.mcpURL([route("http://127.0.0.1:3773")]) == URL(string: "http://127.0.0.1:3773/mcp"))
        #expect(EnvironmentRoutes.mcpURL([route("http://[::1]:3773/")]) == URL(string: "http://[::1]:3773/mcp"))
    }

    @Test func plainHttpOffThisMachineDoesNot() {
        #expect(EnvironmentRoutes.mcpURL([route("http://192.168.1.4:3773/")]) == nil)
        #expect(EnvironmentRoutes.mcpURL([route("http://desk.tail1234.ts.net:3773/")]) == nil)
    }

    @Test func t3ConnectUsesTheRelayAddressAndPreferenceOrderHolds() {
        let relay = route("https://relay.example/e/env-1/", kind: .managedDPoP)
        #expect(relay.isRelay)
        #expect(EnvironmentRoutes.mcpURL([relay]) == URL(string: "https://relay.example/mcp"))
        // The LAN route comes first but cannot be handed out, so T3 Connect's can.
        #expect(EnvironmentRoutes.mcpURL([route("http://192.168.1.4:3773/"), relay]) == URL(string: "https://relay.example/mcp"))
        #expect(EnvironmentRoutes.mcpURL([route("https://desk.example/"), relay]) == URL(string: "https://desk.example/mcp"))
    }

    @Test func noAddressMeansNoURL() {
        #expect(EnvironmentRoutes.mcpURL([]) == nil)
        #expect(EnvironmentRoutes.mcpURL(httpBaseURL: nil) == nil)
        #expect(EnvironmentRoutes.mcpURL(httpBaseURL: URL(string: "https:relay")) == nil)
    }

    @Test func supportIsReadFromTheProtectedResourceMetadataAtThatAddress() async throws {
        let transport = MetadataTransport(responses: [
            "supported.example": (200, #"{"resource":"https://supported.example/mcp","authorization_servers":["https://supported.example"],"scopes_supported":[],"bearer_methods_supported":["header"],"resource_name":"T3"}"#),
            "older.example": (404, #"{"message":"Not found"}"#),
            "spa.example": (200, "<html></html>"),
        ])
        let runtime = EnvironmentRuntime(
            environmentStore: EnvironmentStore(fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("mcp-\(UUID().uuidString).json")),
            credentialStore: InMemoryCredentialStore(),
            httpTransport: transport
        )

        #expect(try await runtime.supportsMcpOAuth(at: URL(string: "https://supported.example/mcp")!))
        #expect(try await runtime.supportsMcpOAuth(at: URL(string: "https://older.example/mcp")!) == false)
        #expect(try await runtime.supportsMcpOAuth(at: URL(string: "https://spa.example/mcp")!) == false)
        // No answer is not a "no", so the caller asks again later.
        await #expect(throws: URLError.self) {
            try await runtime.supportsMcpOAuth(at: URL(string: "https://offline.example/mcp")!)
        }

        let request = try #require(await transport.requests.first)
        #expect(request.url?.absoluteString == "https://supported.example/.well-known/oauth-protected-resource/mcp")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }
}

private actor MetadataTransport: HTTPTransport {
    private let responses: [String: (Int, String)]
    private(set) var requests: [URLRequest] = []

    init(responses: [String: (Int, String)]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard let host = request.url?.host, let answer = responses[host] else {
            throw URLError(.cannotConnectToHost)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.0, httpVersion: nil, headerFields: nil)!
        return (Data(answer.1.utf8), response)
    }
}
