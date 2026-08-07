import Foundation
import XCTest
@testable import T3Code

// Voice Input is account state on the T3 Connect relay, not environment state,
// so these assert the relay contract in packages/contracts/src/relay.ts rather
// than an orchestration RPC. The token provider is injected, which is what lets
// the wire shapes be checked without a Clerk session.
@MainActor
final class NativeVoiceRelayTests: XCTestCase {
    func testIntegrationEndpointsMatchTheRelayContract() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/integrations/openrouter": """
                {"configured":true,"credentialHint":"…9f2","state":"connected",
                 "lastValidatedAt":"2026-08-01T09:00:00.000Z"}
                """,
                "/v1/client/integrations/openrouter/credential": """
                {"configured":true,"state":"validating"}
                """,
                "/v1/client/integrations/openrouter/validate": """
                {"configured":true,"state":"connected"}
                """,
            ]
        )
        let relay = makeRelay(transport)

        let status = try await relay.openRouterIntegration()
        XCTAssertTrue(status.configured)
        XCTAssertEqual(status.state, .connected)
        XCTAssertEqual(status.credentialHint, "…9f2")
        XCTAssertTrue(status.isConnected)

        _ = try await relay.putOpenRouterCredential(apiKey: "sk-or-secret")
        _ = try await relay.validateOpenRouterCredential()
        _ = try await relay.deleteOpenRouterCredential()

        let requests = await transport.requests()
        XCTAssertEqual(
            requests.map { "\($0.method) \($0.path)" },
            [
                "GET /v1/client/integrations/openrouter",
                "PUT /v1/client/integrations/openrouter/credential",
                "POST /v1/client/integrations/openrouter/validate",
                "DELETE /v1/client/integrations/openrouter/credential",
            ]
        )
        XCTAssertEqual(
            Set(requests.map(\.authorization)),
            ["Bearer clerk-token"]
        )
        let credential = try XCTUnwrap(requests[1].body)
        XCTAssertEqual(credential["apiKey"]?.stringValue, "sk-or-secret")
    }

    func testVoiceSettingsFlattenTheNestedCleanupToggle() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/preferences/voice-input": """
                {
                  "model": "google/gemini-2.5-flash",
                  "language": null,
                  "cleanup": {"enabled": false},
                  "dictionary": ["T3", "Hermes"]
                }
                """,
            ]
        )
        let relay = makeRelay(transport)

        let settings = try await relay.voiceInputSettings()
        XCTAssertEqual(settings.model, "google/gemini-2.5-flash")
        XCTAssertNil(settings.language)
        XCTAssertFalse(settings.cleanupEnabled)
        XCTAssertEqual(settings.dictionary, ["T3", "Hermes"])

        _ = try await relay.patchVoiceInputSettings(
            VoiceInputSettingsPatch(cleanupEnabled: true)
        )
        let requests = await transport.requests()
        XCTAssertEqual(requests.last?.method, "PATCH")
        XCTAssertEqual(requests.last?.path, "/v1/client/preferences/voice-input")
        XCTAssertEqual(requests.last?.body?["cleanup"]?["enabled"], JSONValue.bool(true))
    }

    /// `language` has three wire states and only two of them are expressible as
    /// an `Optional<String>`: absent leaves the stored value alone, explicit
    /// null asks the transcriber to detect the language.
    func testPatchOnlyCarriesTheFieldsThatChanged() {
        let untouched = NativeVoiceRelayClient.patchPayload(VoiceInputSettingsPatch())
        XCTAssertEqual(untouched, JSONValue.object([:]))

        let automatic = NativeVoiceRelayClient.patchPayload(
            VoiceInputSettingsPatch(model: "openai/whisper", language: .automatic)
        )
        XCTAssertEqual(automatic["model"]?.stringValue, "openai/whisper")
        XCTAssertEqual(automatic["language"], JSONValue.null)
        XCTAssertNil(automatic["cleanup"])
        XCTAssertNil(automatic["dictionary"])

        let explicit = NativeVoiceRelayClient.patchPayload(
            VoiceInputSettingsPatch(language: .explicit("de"), dictionary: ["T3"])
        )
        XCTAssertEqual(explicit["language"]?.stringValue, "de")
        XCTAssertEqual(explicit["dictionary"], JSONValue.array([.string("T3")]))
        XCTAssertNil(explicit["model"])
    }

    func testAudioModelListingAsksForTheAudioCapability() async throws {
        let transport = VoiceRelayTransport(
            responses: [
                "/v1/client/integrations/openrouter/models": """
                {
                  "models": [
                    {
                      "id": "google/gemini-2.5-flash",
                      "name": "Gemini 2.5 Flash",
                      "providerName": "Google",
                      "capability": "audio",
                      "available": true
                    },
                    {
                      "id": "openai/whisper-1",
                      "name": "Whisper",
                      "providerName": "OpenAI",
                      "capability": "audio",
                      "available": false
                    }
                  ]
                }
                """,
            ]
        )
        let relay = makeRelay(transport)

        let models = try await relay.listOpenRouterModels(capability: "audio")
        XCTAssertEqual(models.map(\.id), ["google/gemini-2.5-flash", "openai/whisper-1"])
        // A model the account cannot currently call still lists, so a selection
        // made on another client stays visible.
        XCTAssertEqual(models.last?.subtitle, "OpenAI · Unavailable")

        let requests = await transport.requests()
        XCTAssertEqual(requests.last?.query, "capability=audio")
    }

    func testRelayFailuresCarryTheServersMessageAndTrace() async throws {
        let transport = VoiceRelayTransport(
            responses: [:],
            status: 402,
            failureBody: #"""
            {"message":"Add credit to your OpenRouter account.","traceId":"trace-9"}
            """#
        )
        let relay = makeRelay(transport)

        do {
            _ = try await relay.validateOpenRouterCredential()
            XCTFail("A rejected relay call must not read as success.")
        } catch let error as T3ConnectRelayError {
            XCTAssertEqual(
                error.errorDescription,
                "Add credit to your OpenRouter account. (trace trace-9)"
            )
        }
    }

    private func makeRelay(_ transport: VoiceRelayTransport) -> NativeVoiceRelayClient {
        NativeVoiceRelayClient(
            baseURL: URL(string: "https://relay.example")!,
            transport: transport
        ) { "clerk-token" }
    }
}

private struct VoiceRelayRequest: Sendable {
    let method: String
    let path: String
    let query: String?
    let authorization: String?
    let body: JSONValue?
}

private actor VoiceRelayTransport: HTTPTransport {
    private let responses: [String: String]
    private let status: Int
    private let failureBody: String
    private var recorded: [VoiceRelayRequest] = []

    init(
        responses: [String: String],
        status: Int = 200,
        failureBody: String = "{}"
    ) {
        self.responses = responses
        self.status = status
        self.failureBody = failureBody
    }

    func requests() -> [VoiceRelayRequest] {
        recorded
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        recorded.append(
            VoiceRelayRequest(
                method: request.httpMethod ?? "GET",
                path: components?.path ?? "",
                query: components?.query,
                authorization: request.value(forHTTPHeaderField: "Authorization"),
                body: request.httpBody.flatMap {
                    try? JSONDecoder.t3.decode(JSONValue.self, from: $0)
                }
            )
        )
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        guard (200..<300).contains(status) else {
            return (Data(failureBody.utf8), response)
        }
        let body = responses[components?.path ?? ""]
            ?? #"{"configured":false,"state":"not_configured"}"#
        return (Data(body.utf8), response)
    }
}
